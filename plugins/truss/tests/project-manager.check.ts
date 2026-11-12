// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss 0.27.0, crew rename-plugin (ADR-0042): the crew lead is the project manager, with no alias and no dual reader.
// Seams 1-17 of plan.md "### rename-plugin (stage 1)", written red first, before any builder edits source.
// register.ts is loaded dynamically inside each test (as main-edit-gate.check.ts does), so a missing export fails one
// title, not the load. Importing codeOnly from hooks-load.check.ts also registers that file's own tests in this run.
//
// The retired crew-lead name is built from pieces below (OLD, OLD_TYPE, OLD_RE), so that no line of this file matches
// the pattern the file itself pins (seam 14).
//
// Run with: node --test tests/project-manager.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs.

import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseLabel } from '../bin/store.ts'
import { codeOnly } from './hooks-load.check.ts'
import { mkRepo, REAL_FACTORY, runCli } from './fixtures/workflow-run/harness.ts'

const PLUGIN = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '').replace(/\\/g, '/')
const REPO_ROOT = `${PLUGIN}/../..`
const REGISTER = `${PLUGIN}/hooks/register.ts`
const FIXTURES = `${PLUGIN}/tests/fixtures/project-manager`

// the retired crew-lead name, in pieces: this file must not hold it (seam 14)
const OLD = 'fore' + 'man'
const OLD_TYPE = `truss:${OLD}`
const OLD_RE = new RegExp('fore' + '(man|men)', 'i')

const PM_TYPE = 'truss:project-manager'

async function exportOf(name: string): Promise<any> {
  let mod: Record<string, unknown>
  try {
    mod = await import('../hooks/register.ts')
  } catch (err) {
    assert.fail(`register.ts did not load: ${(err as Error).message}`)
  }
  assert.notEqual(mod[name], undefined, `hooks/register.ts does not export ${name}`)
  return mod[name]
}
const fnOf = async (name: string): Promise<(...a: unknown[]) => any> => {
  const f = await exportOf(name)
  assert.equal(typeof f, 'function', `${name} is not a function`)
  return f
}

const agent = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, status: 'running', description: `agent ${id}`, ...extra })

const realTmp = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix))).replace(/\\/g, '/')

// every key, at any depth, of a parsed JSON value
function keysOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out)
  else if (typeof v === 'object' && v !== null) {
    for (const [k, x] of Object.entries(v)) {
      out.push(k)
      keysOf(x, out)
    }
  }
  return out
}

// ---------------------------------------------------------------- seams 1-5: the pure functions in hooks/register.ts

test('PROJECT_MANAGER_TYPE is truss:project-manager, and isLeadType is true for it alone', async () => {
  assert.equal(await exportOf('PROJECT_MANAGER_TYPE'), PM_TYPE)
  const isLeadType = await fnOf('isLeadType')
  assert.equal(isLeadType(PM_TYPE), true)
  for (const other of [OLD_TYPE, 'truss:Project-Manager', 'project-manager', 'truss:qc-engineer', '', undefined]) {
    assert.equal(isLeadType(other), false, `isLeadType(${JSON.stringify(other)})`)
  }
})

test('stopperIsLead: an unknown agent goes by its event type, a known one by its type and its parent', async () => {
  const stopperIsLead = await fnOf('stopperIsLead')
  assert.equal(stopperIsLead(undefined, PM_TYPE), true, 'unknown agent, new type')
  assert.equal(stopperIsLead(undefined, OLD_TYPE), false, 'unknown agent, old type')
  assert.equal(stopperIsLead(agent('a1', PM_TYPE, { parentId: 'main-child' }), PM_TYPE), false, 'known new-type agent with a parent')
  assert.equal(stopperIsLead(agent('a2', PM_TYPE), PM_TYPE), true, 'known new-type agent with no parent')
  assert.equal(stopperIsLead(agent('a3', OLD_TYPE), OLD_TYPE), false, 'known old-type agent with no parent')
})

test('leadStartName: a main-thread start of the new type gives its name; every other call gives undefined', async () => {
  const leadStartName = await fnOf('leadStartName')
  assert.equal(leadStartName({ agentId: undefined, subagent_type: PM_TYPE, name: 'auth' }), 'auth')
  assert.equal(leadStartName({ subagent_type: PM_TYPE, name: 'auth' }), 'auth', 'no agentId key at all')
  assert.equal(leadStartName({ agentId: undefined, subagent_type: OLD_TYPE, name: 'auth' }), undefined, 'old type')
  assert.equal(leadStartName({ agentId: 'child-1', subagent_type: PM_TYPE, name: 'auth' }), undefined, 'a call from inside an agent')
  assert.equal(leadStartName({ agentId: undefined, subagent_type: PM_TYPE, name: '' }), undefined, 'empty name')
  assert.equal(leadStartName({ agentId: undefined, subagent_type: PM_TYPE }), undefined, 'no name')
  assert.equal(leadStartName({ agentId: undefined, subagent_type: PM_TYPE, name: 7 }), undefined, 'a name that is not text')
})

test('workflowRoleVerdict refuses role key project-manager and agentType truss:project-manager', async () => {
  const workflowRoleVerdict = await fnOf('workflowRoleVerdict')
  const ok = { agentType: 'general-purpose', model: 'sonnet', effort: 'low' }
  assert.equal(workflowRoleVerdict({ runner: ok }), undefined, 'control: a plain role table is allowed')
  const byType = workflowRoleVerdict({ runner: { ...ok, agentType: PM_TYPE } })
  assert.ok(byType && /^\[truss\] Refused:/.test(byType.deny), `agentType ${PM_TYPE} must be refused, got ${JSON.stringify(byType)}`)
  assert.match(byType.deny, /project-manager/, 'the refusal names the type')
  const byKey = workflowRoleVerdict({ 'project-manager': ok })
  assert.ok(byKey && /^\[truss\] Refused:/.test(byKey.deny), `role key project-manager must be refused, got ${JSON.stringify(byKey)}`)
})

test('IDLE_LEAD_KIND is idle-project-manager, and the idle text starts with [truss] idle project manager:', async () => {
  assert.equal(await exportOf('IDLE_LEAD_KIND'), 'idle-project-manager')
  const idleProjectManagerText = await fnOf('idleProjectManagerText')
  const text = idleProjectManagerText('auth', 'auth', 30, 'billing')
  assert.equal(typeof text, 'string')
  assert.ok(text.startsWith('[truss] idle project manager:'), text)
})

// ---------------------------------------------------------------- seams 6, 16 (retro) share a runner over a real events.jsonl

// A truss dir with one run heading and `events` as events.jsonl, counted by the real retro CLI; returns the run's stalls.
function retroStalls(events: Record<string, unknown>[]): any {
  const dir = realTmp('pm-retro-')
  writeFileSync(`${dir}/decisions.md`, '# Decisions\n## Run 2026-10-27T09:00:30Z | rename fixture\n- 09:05 | start the crews | plan approved | checker: none | followed\n')
  writeFileSync(`${dir}/events.jsonl`, events.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const r = spawnSync(process.execPath, [`${PLUGIN}/retro/cli.ts`, 'counts', dir], { encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, `retro counts failed: ${r.stderr}`)
  const out = JSON.parse(r.stdout)
  const run = out.runs.find((x: any) => typeof x.stalls === 'object' && x.stalls !== null)
  assert.ok(run, `no run holds placed stalls: ${r.stdout.slice(0, 400)}`)
  return { stalls: run.stalls, run }
}
const stallEvent = (i: number, kind: string, crew = 'auth') => ({ v: 1, ts: new Date(Date.UTC(2026, 9, 27, 9, 10, i)).toISOString(), event: 'stall', crew, agent: crew, kind, minutes: 15 })

test('retro counts one idle-project-manager stall and ignores an old-kind stall: stalls holds exactly agent and idleProjectManager', () => {
  const { stalls } = retroStalls([stallEvent(1, 'idle-project-manager'), stallEvent(2, `idle-${OLD}`)])
  assert.deepEqual(Object.keys(stalls).sort(), ['agent', 'idleProjectManager'])
  assert.equal(stalls.idleProjectManager, 1)
  assert.equal(stalls.agent, 0, 'the old kind is not an agent stall either')
})

// ---------------------------------------------------------------- seams 7, 8: the schemas

test('docs/events.schema.json: the stall kind enum is exactly agent and idle-project-manager', () => {
  const schema = JSON.parse(readFileSync(`${PLUGIN}/docs/events.schema.json`, 'utf8'))
  const found: any[] = []
  const walk = (v: any) => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (typeof v === 'object' && v !== null) {
      if (v.if?.properties?.event?.const === 'stall') found.push(v)
      Object.values(v).forEach(walk)
    }
  }
  walk(schema)
  assert.equal(found.length, 1, 'one if/then block for the stall event')
  assert.deepEqual(found[0].then.properties.kind.enum, ['agent', 'idle-project-manager'])
})

test('docs/truss-config.schema.json: promptOverrides takes the project-manager key and refuses the old one', () => {
  const schema = JSON.parse(readFileSync(`${PLUGIN}/docs/truss-config.schema.json`, 'utf8'))
  const po = schema.properties.promptOverrides
  assert.equal(po.type, 'object')
  assert.equal(po.additionalProperties, false, 'additionalProperties stays false')
  const resolve = (node: any): any => {
    if (node && typeof node.$ref === 'string') {
      assert.ok(node.$ref.startsWith('#/'), node.$ref)
      return node.$ref.slice(2).split('/').reduce((n: any, k: string) => n?.[k], schema)
    }
    return node
  }
  // a structural walk, since the repo has no JSON Schema library: type, minProperties, properties, additionalProperties, pattern
  const accepts = (value: Record<string, unknown>): boolean => {
    const keys = Object.keys(value)
    if (typeof po.minProperties === 'number' && keys.length < po.minProperties) return false
    for (const k of keys) {
      if (!Object.hasOwn(po.properties, k)) return false
      const prop = resolve(po.properties[k])
      if (typeof value[k] !== 'string') return false
      if (prop.pattern !== undefined && !new RegExp(prop.pattern).test(value[k] as string)) return false
    }
    return true
  }
  assert.equal(typeof schema.$defs.promptFile.pattern, 'string')
  assert.equal(accepts({ 'qc-engineer': '.claude/truss/prompts/qc-engineer.md' }), true, 'control: an existing key passes')
  assert.equal(accepts({ 'project-manager': '.claude/truss/prompts/project-manager.md' }), true)
  assert.equal(accepts({ [OLD]: '.claude/truss/prompts/project-manager.md' }), false, 'the old key fails')
  assert.equal(accepts({ 'project-manager': 'prompts/project-manager.md' }), false, 'the path rule still holds')
})

// ---------------------------------------------------------------- seams 9, 16: factory start on a fixture truss dir

// Copies tests/fixtures/project-manager/<name> into a fresh truss dir (a `replace` map turns placeholders in the goal files into
// words), makes a temp repo, and runs `factory start --stage next --args-file`. Returns the printed line and the file's content.
function startWorld(name: string, replace: Record<string, string> = {}) {
  const dir = realTmp('pm-start-')
  cpSync(`${FIXTURES}/${name}`, dir, { recursive: true })
  writeFileSync(`${dir}/decisions.md`, '')
  writeFileSync(`${dir}/events.jsonl`, '')
  for (const f of readdirSync(`${dir}/goals`)) {
    let text = readFileSync(`${dir}/goals/${f}`, 'utf8')
    for (const [from, to] of Object.entries(replace)) text = text.split(from).join(to)
    writeFileSync(`${dir}/goals/${f}`, text)
  }
  const repo = realpathSync(mkRepo()).replace(/\\/g, '/')
  const argsFile = `${dir}/start-args.json`
  const res = runCli(REAL_FACTORY, 'start', ['--dir', dir, '--repo', repo, '--stage', 'next', '--args-file', argsFile], repo)
  let file: any
  try {
    file = JSON.parse(readFileSync(argsFile, 'utf8'))
  } catch {}
  return { res, file, dir, repo }
}
const slugsOf = (list: any): string[] => (Array.isArray(list) ? list.map((x: any) => x.slug) : [])

test('factory start on a goal that says ## Engine project-manager puts the crew under projectManagers, with no old-name key printed', () => {
  const { res, file } = startWorld('engine')
  assert.equal(res.status, 0, `start exit ${res.status}: ${res.stdout.slice(0, 300)} ${res.stderr.slice(0, 300)}`)
  assert.ok(res.json, `stdout is not one JSON line: ${res.stdout.slice(0, 300)}`)
  assert.ok(file, 'the args file was written')
  assert.deepEqual(slugsOf(res.json.projectManagers), ['auth'], 'printed line: projectManagers')
  assert.deepEqual(slugsOf(file.projectManagers), ['auth'], 'args file: projectManagers')
  for (const [where, v] of [['printed line', res.json], ['args file', file]] as const) {
    const bad = keysOf(v).filter((k) => OLD_RE.test(k))
    assert.deepEqual(bad, [], `${where} has an old-name key`)
  }
})

// ---------------------------------------------------------------- seam 10: the workflow scripts refuse the new type as a role

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
async function runScript(file: string, args: unknown) {
  const text = readFileSync(`${PLUGIN}/workflows/${file}`, 'utf8').replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls: { prompt: string; opts: any }[] = []
  const stub = async (prompt: string, opts: any = {}) => {
    calls.push({ prompt, opts })
    return null
  }
  const parallel = async (thunks: any[]) => Promise.all(thunks.map(async (th) => { try { return await (typeof th === 'function' ? th() : th) } catch { return null } }))
  const pipeline = async (items: any[], ...stages: any[]) =>
    Promise.all(items.map(async (item, i) => {
      try {
        let prev = item
        for (const st of stages) prev = await st(prev, item, i)
        return prev
      } catch {
        return null
      }
    }))
  let result: any
  let error: any
  try {
    result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', text)(stub, parallel, pipeline, () => 0, () => 0, structuredClone(args), {})
  } catch (e) {
    error = e
  }
  return { result, error, calls }
}
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
}
const planArgs = (roles: unknown) => ({
  truss: { kind: 'plan', dir: '/proj/.truss', repo: '/proj', plugin: PLUGIN, schema: 'PLAN-SCHEMA-TEXT', architecture: '/proj/docs/ARCH.md', maxParallelCrews: 3, reworkAllowance: 2, roles, scriptPath: `${PLUGIN}/workflows/plan.js` },
  brief: 'BRIEF-TEXT: build the thing',
})
const stageArgs = (roles: unknown) => ({
  truss: {
    kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: PLUGIN, target: 'main', reworkAllowance: 2, roles, scriptPath: `${PLUGIN}/workflows/stage.js`,
    crews: [{
      slug: 'a', stage: 1, goalFile: '/proj/.truss/goals/a.md', goal: 'GOAL-TEXT', owns: ['src/**'], acceptanceTest: 'node --test tests/a.check.ts', highImpact: [], stressTest: false,
      scope: 'SCOPE', worktree: '/wt/a', branch: 'truss/a', base: 'd4'.repeat(20), architecture: '/proj/docs/ARCH.md', adrs: [], resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {},
    }],
  },
})

test('plan.js and stage.js refuse a role whose agentType is truss:project-manager, before any agent() call', async () => {
  // plan.js: the designer role
  const planOk = await runScript('plan.js', planArgs(ROLES))
  assert.ok(planOk.calls.length >= 1, 'control: plan.js with plain roles reaches agent()')
  const plan = await runScript('plan.js', planArgs({ ...ROLES, designer: { ...ROLES.designer, agentType: PM_TYPE } }))
  assert.ok(plan.error, 'plan.js must throw for a designer role of type truss:project-manager')
  assert.match(String(plan.error.message), /not allowed/)
  assert.equal(plan.calls.length, 0, 'plan.js made an agent() call with the project manager type')
  // stage.js: the runner role, the first spawn of a crew
  const stageOk = await runScript('stage.js', stageArgs(ROLES))
  assert.ok(stageOk.calls.length >= 1, 'control: stage.js with plain roles reaches agent()')
  const stage = await runScript('stage.js', stageArgs({ ...ROLES, runner: { ...ROLES.runner, agentType: PM_TYPE } }))
  assert.equal(stage.error, undefined, String(stage.error))
  assert.equal(stage.calls.length, 0, 'stage.js made an agent() call with the project manager type')
  assert.equal(stage.result[0].state, 'stopped')
  assert.equal(stage.result[0].tag, 'BLOCKED')
  assert.equal(stage.result[0].at, 'red')
})

// ---------------------------------------------------------------- seam 11: parseLabel is unchanged (a regression guard; the recording is in git before any builder commit)

// the labels in tests/fixtures/transcripts/: every `label` value in a json or jsonl file, and the name in a *.meta.json
function transcriptLabels(): string[] {
  const root = `${PLUGIN}/tests/fixtures/transcripts`
  const found = new Set<string>()
  const labelsIn = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(labelsIn)
    else if (typeof v === 'object' && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'label' && typeof x === 'string') found.add(x)
        else labelsIn(x)
      }
    }
  }
  const walk = (dir: string) => {
    for (const n of readdirSync(dir).sort()) {
      const p = `${dir}/${n}`
      if (statSync(p).isDirectory()) walk(p)
      else if (n.endsWith('.jsonl')) {
        for (const line of readFileSync(p, 'utf8').split('\n')) {
          try {
            labelsIn(JSON.parse(line))
          } catch {}
        }
      } else if (n.endsWith('.json')) {
        const v = JSON.parse(readFileSync(p, 'utf8'))
        labelsIn(v)
        if (n.endsWith('.meta.json') && typeof v.name === 'string') found.add(v.name)
      }
    }
  }
  walk(root)
  return [...found].sort()
}

test('parseLabel on every label in tests/fixtures/transcripts/ equals the recorded labels.expected.json', () => {
  const expected = JSON.parse(readFileSync(`${FIXTURES}/labels.expected.json`, 'utf8'))
  const got: Record<string, unknown> = {}
  for (const l of transcriptLabels()) got[l] = parseLabel(l) ?? null
  assert.ok(Object.keys(got).length > 0, 'the transcript fixtures hold labels')
  assert.deepEqual({ labels: got }, expected)
})

// ---------------------------------------------------------------- seams 12, 13: the agent file and the run skill's start block

test('agents/project-manager.md has name: project-manager, and no file in agents/ has the old name', () => {
  const text = readFileSync(`${PLUGIN}/agents/project-manager.md`, 'utf8')
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  assert.ok(head, 'the agent file starts with a front-matter block')
  assert.match(head[1], /^name:\s*project-manager\s*$/m)
  const names = readdirSync(`${PLUGIN}/agents`, { recursive: true }).map(String)
  assert.deepEqual(names.filter((n) => OLD_RE.test(n)), [])
})

test('the run skill crew-lead start block names subagent_type truss:project-manager', () => {
  const text = readFileSync(`${PLUGIN}/skills/run/SKILL.md`, 'utf8')
  const blocks = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1])
  const starts = blocks.filter((b) => b.includes('isolation: "worktree"') && b.includes('run_in_background: true'))
  assert.equal(starts.length, 1, 'one fenced block has isolation: "worktree" and run_in_background: true')
  assert.match(starts[0], /subagent_type:\s*"truss:project-manager"/)
})

// ---------------------------------------------------------------- seams 14, 15: no old name in the crew's paths; a bare PM is defined

const SKIP_EXT = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|pdf|zip|gz)$/i
function filesUnder(dir: string, out: string[] = []): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const n of names.sort()) {
    if (n === '.git' || n === 'node_modules' || n === '.truss-scratch') continue
    const p = `${dir}/${n}`
    if (statSync(p).isDirectory()) filesUnder(p, out)
    else if (!SKIP_EXT.test(n) && statSync(p).size < 8_000_000) out.push(p)
  }
  return out
}
// this crew's paths (plan.md, seam 14): plugin dirs, the five docs/*.json, and the named prose files
function crewFiles(): string[] {
  const files: string[] = []
  for (const d of ['hooks', 'bin', 'retro', 'workflows', 'agents', 'skills', 'tests', 'evals']) filesUnder(`${PLUGIN}/${d}`, files)
  for (const f of readdirSync(`${PLUGIN}/docs`).sort()) if (f.endsWith('.json')) files.push(`${PLUGIN}/docs/${f}`)
  files.push(`${PLUGIN}/README.md`, `${PLUGIN}/docs/backlog.md`, `${PLUGIN}/docs/truss.svg`, `${REPO_ROOT}/docs/knowledge/store.md`)
  return files
}
const rel = (p: string): string => relative(REPO_ROOT, p).replace(/\\/g, '/')

test('no line matches the old crew-lead name in this crew\'s paths', () => {
  const hits: string[] = []
  const files = new Set<string>()
  for (const f of crewFiles()) {
    const lines = readFileSync(f, 'utf8').split(/\r?\n/)
    lines.forEach((l, i) => {
      if (OLD_RE.test(l)) {
        hits.push(`${rel(f)}:${i + 1}`)
        files.add(f)
      }
    })
  }
  assert.equal(hits.length, 0, `${hits.length} lines in ${files.size} files match the old name; first: ${hits.slice(0, 5).join(', ')}`)
})

test('each .md file of this crew that keeps a bare PM defines it as program manager (PM)', () => {
  const mds = [
    ...filesUnder(`${PLUGIN}/agents`).filter((f) => f.endsWith('.md')),
    ...filesUnder(`${PLUGIN}/skills`).filter((f) => f.endsWith('.md')),
    `${PLUGIN}/README.md`,
    `${PLUGIN}/docs/backlog.md`,
    `${REPO_ROOT}/docs/knowledge/store.md`,
    `${REPO_ROOT}/.claude/agents/truss-workflow-scripts.md`,
  ]
  const bad = mds.filter((f) => {
    const text = readFileSync(f, 'utf8')
    return /\bPM\b/.test(text) && !text.includes('program manager (PM)')
  })
  assert.deepEqual(bad.map(rel), [], 'these files use PM and never define it as "program manager (PM)"')
})

// ---------------------------------------------------------------- seam 16: the migration stress test

test('a 0.26.0-shaped run and an old-type start mixed with new-type leads', async () => {
  const [isLeadType, stopperIsLead, leadStartName, crewOf, planVerdict, parsePlan] = await Promise.all(
    ['isLeadType', 'stopperIsLead', 'leadStartName', 'crewOf', 'planVerdict', 'parsePlan'].map(fnOf),
  )

  // 1. factory start on a 0.26.0-shaped plan whose goal files say the old engine word: the default project manager path
  const { res, file, dir } = startWorld('migration', { OLD_ENGINE_WORD: OLD })
  assert.equal(res.status, 0, `start exit ${res.status}: ${res.stdout.slice(0, 300)} ${res.stderr.slice(0, 300)}`)
  assert.ok(res.json, `stdout is not one JSON line: ${res.stdout.slice(0, 300)}`)
  assert.ok(file, 'the args file was written')
  for (const [where, v] of [['printed line', res.json], ['args file', file]] as const) {
    assert.deepEqual(keysOf(v).filter((k) => OLD_RE.test(k)), [], `${where} has an old-name key`)
    assert.deepEqual(slugsOf(v.projectManagers).sort(), ['auth', 'billing'], `${where}: projectManagers`)
  }

  // 2. the agent list: two new-type leads with one member each, and one old-type agent with one child
  const leadA = agent('lead-auth', PM_TYPE, { label: 'auth' })
  const leadB = agent('lead-billing', PM_TYPE, { label: 'billing' })
  const memberA = agent('mem-auth', 'proj:builder', { parentId: 'lead-auth', label: 'auth-builder' })
  const memberB = agent('mem-billing', 'proj:builder', { parentId: 'lead-billing', label: 'billing-builder' })
  const oldLead = agent('lead-old', OLD_TYPE, { label: 'old' })
  const oldChild = agent('mem-old', 'proj:builder', { parentId: 'lead-old', label: 'old-builder' })
  const all = [leadA, memberA, leadB, memberB, oldLead, oldChild]

  // leadStartName and the plan gate, called the way the Agent handler calls them
  const planText = readFileSync(`${dir}/plan.json`, 'utf8')
  const plan = parsePlan(planText)
  assert.ok(plan, 'the fixture plan parses')
  const waiting = structuredClone(JSON.parse(planText))
  waiting.crews.find((c: any) => c.slug === 'billing').stage = 2
  const waitingPlan = parsePlan(JSON.stringify(waiting))
  const gate = (p: any, call: any) => {
    const name = leadStartName(call)
    return name === undefined ? undefined : planVerdict(p, name)
  }
  const startOf = (type: string, name: string) => ({ agentId: undefined, subagent_type: type, name })
  assert.equal(leadStartName(startOf(PM_TYPE, 'auth')), 'auth')
  assert.equal(leadStartName(startOf(PM_TYPE, 'billing')), 'billing')
  assert.equal(leadStartName(startOf(OLD_TYPE, 'billing')), undefined, 'the old-type start has no lead name')
  assert.equal(gate(plan, startOf(PM_TYPE, 'auth')), undefined, 'auth may start')
  assert.match(gate(waitingPlan, startOf(PM_TYPE, 'billing'))?.deny ?? '', /stage 1 isn't merged yet: auth/, 'the plan gate holds a new-type start of billing')
  assert.equal(gate(waitingPlan, startOf(OLD_TYPE, 'billing')), undefined, 'the old-type start yields no plan-gate verdict, allow or deny')

  // stopperIsLead
  for (const lead of [leadA, leadB]) assert.equal(stopperIsLead(lead, lead.type), true, lead.id)
  assert.equal(stopperIsLead(oldLead, oldLead.type), false, 'the old-type agent is no lead at the stop gate')
  assert.equal(stopperIsLead(undefined, oldLead.type), false)
  assert.equal(isLeadType(oldLead.type), false)

  // crewOf, which the idle check uses to find the crews it visits
  const crewOfLead = crewOf('lead-auth', all)
  assert.ok(crewOfLead, 'a crew for the first new-type lead')
  assert.equal(crewOfLead.crew, 'auth')
  assert.equal(crewOf('mem-auth', all)?.crew, 'auth')
  assert.equal(crewOf('mem-auth', all)?.projectManagerId, 'lead-auth')
  assert.equal(crewOf('mem-auth', all)?.projectManagerName, 'auth')
  assert.equal(crewOf('lead-billing', all)?.crew, 'billing')
  assert.equal(crewOf('mem-billing', all)?.crew, 'billing')
  assert.equal(crewOf('lead-old', all), undefined, 'no crew for the old-type agent')
  assert.equal(crewOf('mem-old', all), undefined, 'no crew for its child')

  // 3. retro on 50 stalls of each kind, interleaved, 20 agent stalls and the spawns of all three agents
  const spawn = (i: number, name: string, id: string, type: string) => ({ v: 1, ts: new Date(Date.UTC(2026, 9, 27, 9, 1, i)).toISOString(), event: 'spawn', crew: name, agent: name, agentId: id, type, model: 'opus', effort: 'medium', by: 'main' })
  const events: Record<string, unknown>[] = [spawn(1, 'auth', 'lead-auth', PM_TYPE), spawn(2, 'billing', 'lead-billing', PM_TYPE), spawn(3, 'old', 'lead-old', OLD_TYPE)]
  for (let i = 0; i < 50; i++) {
    events.push(stallEvent(10 + i * 3, 'idle-project-manager', i % 2 ? 'billing' : 'auth'))
    events.push(stallEvent(11 + i * 3, `idle-${OLD}`, 'old'))
    if (i < 20) events.push(stallEvent(12 + i * 3, 'agent', 'auth'))
  }
  const { stalls, run } = retroStalls(events)
  assert.equal(stalls.idleProjectManager, 50, 'idleProjectManager counts the new kind only')
  assert.equal(stalls.agent, 20)
  assert.deepEqual(Object.keys(stalls).sort(), ['agent', 'idleProjectManager'], 'no other stalls key')
  assert.equal(run.spawns.total, 3, 'the spawns of all three agents are counted')
})

// ---------------------------------------------------------------- seam 17: the two gates call the pure functions

test('the stop gate and the lead-start gate go through the pure functions', () => {
  const rawSrc = readFileSync(REGISTER, 'utf8')
  const code = codeOnly(rawSrc) // comments and string text blanked, same length as rawSrc
  const topFn = (name: string) => {
    const m = new RegExp(`(^|\\n)(export )?(async )?function ${name}\\b`).exec(code)
    assert.ok(m, `register.ts has no top-level function ${name}`)
    const start = m.index
    const end = code.indexOf('\n}', start + 1)
    assert.ok(end > start, `no end found for function ${name}`)
    return { start, end, body: code.slice(start, end) }
  }

  // the stop gate's lead check
  assert.ok(topFn('stopperOf').body.includes('stopperIsLead('), 'the body of stopperOf must call stopperIsLead(')

  // the lead-start gate
  const at = rawSrc.search(/on\(\s*'tool\.call'\s*,\s*\{\s*tool:\s*'Agent'\s*\}/)
  assert.ok(at >= 0, "no on('tool.call', { tool: 'Agent' } handler")
  const stop = code.indexOf('.catch(failOpen)', at)
  assert.ok(stop > at, 'the Agent handler must end with .catch(failOpen)')
  const handler = code.slice(at, stop)
  assert.ok(handler.includes('leadStartName('), 'the Agent handler must call leadStartName(')
  const verdictCalls = [...handler.matchAll(/planVerdict\(\s*[\w.]+\s*,\s*([^)]+?)\s*\)/g)]
  assert.equal(verdictCalls.length, 1, 'the Agent handler calls planVerdict( once')
  const fed = verdictCalls[0][1]
  if (!fed.startsWith('leadStartName(')) {
    assert.match(fed, /^\w+$/, `planVerdict is fed ${fed}, which is not a name`)
    assert.ok(new RegExp(`(const|let)\\s+${fed}\\s*=\\s*leadStartName\\(`).test(handler), `${fed} must be set from leadStartName(`)
    assert.equal([...handler.matchAll(new RegExp(`\\b${fed}\\s*=(?!=)`, 'g'))].length, 1, `${fed} must be assigned only from leadStartName(`)
  }

  // the type is compared in isLeadType and nowhere else
  const isLead = topFn('isLeadType')
  assert.ok(rawSrc.slice(isLead.start, isLead.end).includes('PROJECT_MANAGER_TYPE') || rawSrc.slice(isLead.start, isLead.end).includes(`'${PM_TYPE}'`), 'isLeadType must compare the type')
  const compared: string[] = []
  for (const re of [/\bPROJECT_MANAGER_TYPE\b/g, /'truss:project-manager'/g]) {
    for (const m of rawSrc.matchAll(re)) {
      const i = m.index
      const j = i + m[0].length
      if (re.source.startsWith("'") && code[i] !== "'") continue // inside a comment
      if (i >= isLead.start && j <= isLead.end) continue
      const before = code.slice(Math.max(0, i - 8), i)
      const after = code.slice(j, j + 8)
      if (/(===|!==|==|!=)\s*$/.test(before) || /^\s*(===|!==|==|!=)/.test(after)) compared.push(`line ${rawSrc.slice(0, i).split('\n').length}`)
    }
  }
  assert.deepEqual(compared, [], 'the crew-lead type is compared outside isLeadType')
  assert.ok(topFn('workflowRoleVerdict').body.includes('isLeadType(role.agentType)'), 'the workflow-role refusal must call isLeadType(role.agentType)')

  // no export names the old crew lead
  const exported: string[] = []
  for (const m of code.matchAll(/\bexport\s+(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g)) exported.push(m[1])
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}/g)) exported.push(...m[1].split(',').map((s) => s.trim()))
  assert.deepEqual(exported.filter((n) => OLD_RE.test(n)), [], 'an export names the old crew lead')
})

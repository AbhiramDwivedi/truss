// @ts-nocheck
// factory-gaps (truss 0.29.0 items 3, 4, 7, 8): plan-write keeps the full plan when the planMd field is a stub, a bare `dir/` owns entry
// means `dir/**` (owns-check, the stage split, plan-check warning), every --dir reader treats a relative dir as dirOf does (ADR-0027 F-67
// item 2), and stage green installs missing dependencies (installMissingDeps, called by `check --expect green`).
// Run with: node --test tests/gaps-029.check.ts
//
// Linked node_modules: the case makes a real junction (fs.symlinkSync type 'junction': a plain symlink off win32, a junction on win32, which
// needs no privilege), so lstat sees a link on every platform. No real npm runs: installMissingDeps gets a stub spawn, and the end-to-end
// case puts a fake `npm` first on PATH. No Windows or macOS host ran this file; the darwin and win32 branches run on fixture paths.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter } from 'node:path'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as fac from '../bin/factory.ts'
import { addCrewWorktree, assertOneLine, crew, git, mkEnv, mkRepo, mkRun, mkTrussDir, planObj, putFile, runCli, tmp, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const FACTORY = `${PLUGIN}/bin/factory.ts`
const flat = (p) => String(p).replace(/\\/g, '/')

// ---------------------------------------------------------------- item 3: plan-write

const fenced = (json, md) => `Report.\n\n\`\`\`\`json plan.json\n${json}\n\`\`\`\`\n\n\`\`\`\`markdown plan.md\n${md}\n\`\`\`\`\n`
const planOf = () => planObj([crew('arch', { stage: 0, verdict: 'design' })], { approval: 'client', approvedAt: null })
const FULL_MD = '# Plan\n\nGoal: build it.\n\n| crew | modules | owns |\n|---|---|---|\n| arch | arch | src/arch/** |\n| other | other | src/other/** |\n\nWhy this split: two disjoint trees.\n'

function planWrite(result) {
  const env = mkEnv({ useRealPlugin: true })
  const { dir } = mkRun(env.transcripts, 'wf_plan', [{ id: 'aarch', label: 'truss-designer', agentType: 'truss:design-engineer', metaModel: 'opus', result, startTs: '2026-10-29T10:00:00.000Z' }])
  const res = env.run('plan-write', { transcript: dir, label: 'truss-designer' })
  const read = (f) => { try { return readFileSync(`${env.dir}/${f}`, 'utf8') } catch { return undefined } }
  return { res, md: read('plan.md') }
}

test('plan-write writes the full fenced plan when the planMd field is a stub', () => {
  const report = fenced(JSON.stringify(planOf()), FULL_MD)
  for (const stub of ['See plan.json.', 'plan.md is in the report above', '# Plan\n\n(written to the fenced block)']) {
    const out = planWrite({ report, planJson: JSON.stringify(planOf()), planMd: stub })
    assert.equal(out.res.status, 0, out.res.stderr)
    assert.equal(out.md, FULL_MD, `a stub planMd field (${JSON.stringify(stub)}) must not replace the fenced plan`)
  }
})

test('plan-write keeps a full planMd field over the fenced block', () => {
  const full = FULL_MD + '\n## Notes\n\nA longer field with the same crew table rows.\n'
  const out = planWrite({ report: fenced(JSON.stringify(planOf()), FULL_MD), planJson: JSON.stringify(planOf()), planMd: full })
  assert.equal(out.res.status, 0, out.res.stderr)
  assert.equal(out.md, full)
  // the field also wins over a shorter, differently worded fenced block with its own table rows
  const out2 = planWrite({ report: fenced(JSON.stringify(planOf()), '| crew | x |\n| a | b |\n'), planJson: JSON.stringify(planOf()), planMd: full })
  assert.equal(out2.md, full)
})

// ---------------------------------------------------------------- item 4: a bare dir/ owns entry

test('owns-check treats a bare dir/ entry as dir/**', () => {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' }, files: { 'a.txt': 'base\n' } })
  writePlan(env.dir, planObj([crew('x', { owns: ['plugins/x/'], status: 'running' })]))
  const wt = addCrewWorktree(env.repo, 'x')
  putFile(wt, 'plugins/x/a.ts', 'a\n', 'inside')
  putFile(wt, 'plugins/x/deep/b.ts', 'b\n', 'inside deep')
  putFile(wt, 'plugins/x/.hidden/c.ts', 'c\n', 'inside a dot dir')
  const ok = env.run('owns-check', { slug: 'x' })
  assert.equal(ok.status, 0, ok.stdout)
  assert.deepEqual(assertOneLine(ok), { ok: true, exempt: [] })
  putFile(wt, 'plugins/x2/a.ts', 'z\n', 'a sibling prefix')
  const bad = env.run('owns-check', { slug: 'x' })
  assert.equal(bad.status, 1, bad.stdout)
  assert.deepEqual(assertOneLine(bad).outside, ['plugins/x2/a.ts'])
})

// A minimal stubbed-agent run of workflows/stage.js up to the split: the planner is scripted, a runner answers every factory command
// ok, every other member reports BLOCKED so the run ends. The outcome is the number of planner spawns and the stop, never script text.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const ROLES = {
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
const HEAD = 'a1'.repeat(20)
const T1 = { name: 'write-tests', role: 'tester', effort: 'medium', files: ['tests/a.check.ts'], reads: [], brief: 'write the tests', after: [] }
const bld = (files) => ({ name: 'build-it', role: 'builder', effort: 'medium', files, reads: ['tests/a.check.ts'], brief: 'build it', after: ['write-tests'] })
async function stageSplit(owns, builderFiles) {
  const body = readFileSync(`${PLUGIN}/workflows/stage.js`, 'utf8').replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls = []
  const entry = { slug: 'a', stage: 1, goalFile: '/proj/.truss/goals/a.md', goal: 'GOAL', owns, acceptanceTest: 'true', highImpact: [], stressTest: false, scope: 'SCOPE', worktree: '/wt/a', branch: 'truss/a', base: 'd4'.repeat(20), architecture: '/proj/docs/ARCH.md', adrs: [], resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {} }
  const args = { truss: { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: PLUGIN, target: 'main', reworkAllowance: 2, roles: ROLES, scriptPath: `${PLUGIN}/workflows/stage.js`, crews: [entry] } }
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, label: opts.label })
    await new Promise((r) => setImmediate(r))
    if (/^a-planner(-\d+)?$/.test(String(opts.label))) return structuredClone({ tasks: [T1, bld(builderFiles)], stop: null })
    if (/-runner(-\d+)?$/.test(String(opts.label))) return { exit: 0, stdout: JSON.stringify({ ok: true, head: HEAD, admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048, reaped: [], skipped: [], merged: true, outside: [], tests: [] }) }
    return { task: 'whatever', marker: 'BLOCKED', branch: 'feat/x', commit: 'c0'.repeat(20), proof: '', text: 'stop here' }
  }
  const parallel = async (thunks) => Promise.all(thunks.map(async (th) => { try { return await (typeof th === 'function' ? th() : th) } catch { return null } }))
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (item, i) => { try { let p = item; for (const st of stages) p = await st(p, item, i); return p } catch { return null } }))
  const result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, () => {}, () => {}, structuredClone(args), {})
  const planners = calls.filter((c) => /^a-planner(-\d+)?$/.test(String(c.label)))
  return { result, planners, rejected: planners.length > 1 }
}

test('the stage split treats a bare dir/ entry as dir/**', async () => {
  const ok = await stageSplit(['src/', 'tests/*.ts'], ['src/a.ts', 'src/deep/b.ts'])
  assert.equal(ok.planners.length, 1, `files under an owned src/ must pass the split check on the first plan: ${ok.planners.at(-1)?.prompt.split('Your last plan failed')[1]?.slice(0, 300)}`)
  const sibling = await stageSplit(['src/', 'tests/*.ts'], ['src2/a.ts'])
  assert.equal(sibling.planners.length, 2, 'a sibling-prefix file is sent back once')
  assert.match(sibling.planners[1].prompt, /src2\/a\.ts, which matches none of the crew owns/)
  const result = Array.isArray(sibling.result) ? sibling.result[0] : sibling.result
  assert.equal(JSON.stringify(result).includes('failed these checks twice'), true, JSON.stringify(result).slice(0, 300))
})

test('plan-check warns on a bare-directory owns entry', () => {
  const env = mkEnv()
  writePlan(env.dir, planObj([crew('alpha', { owns: ['plugins/alpha/', 'tests/*.ts'] }), crew('beta', { owns: ['src/beta/**'] })]))
  const res = env.run('plan-check', { repo: null })
  const json = assertOneLine(res)
  assert.equal(res.status, 0, res.stdout)
  assert.equal(json.ok, true)
  const hits = (json.warnings ?? []).filter((w) => w.includes('plugins/alpha/'))
  assert.equal(hits.length, 1, `one warning names the bare-directory entry: ${JSON.stringify(json.warnings)}`)
  assert.ok(!(json.warnings ?? []).some((w) => w.includes('src/beta/**')), 'a ** entry gets no warning')
})

// ---------------------------------------------------------------- item 7: a relative --dir

test('inbox, queue, cost and start resolve a relative --dir like dirOf', () => {
  const repo = mkRepo({ config: { merge: 'sequential', target: 'main' } })
  const REL = 'rel/sess-one'
  const tr = tmp('gaps-tr-')
  const extra = { TRUSS_TRANSCRIPTS_ROOT: tr }
  const shared = `${repo}/.git/truss/shared`
  const cases = [
    ['inbox list', 'inbox', []],
    ['inbox resolve', 'resolve', ['E-1', '--decision', 'approve', '--by', 'pm', '--code', 'abc']],
    ['inbox escalate', 'escalate', ['--kind', 'client-trigger', '--title', 'approve the plan', '--ref', 'run']],
    ['inbox mark-applied', 'mark-applied', ['--id', 'E-1']],
    ['queue-next', 'queue-next', []],
    ['queue-set', 'queue-set', ['--id', 'q1', '--state', 'new']],
    ['cost', 'cost', []],
  ]
  for (const [name, command, rest] of cases) {
    const res = runCli(FACTORY, command, ['--repo', repo, '--dir', REL, ...rest], repo, extra)
    const json = assertOneLine(res)
    assert.equal(res.status, 2, `${name}: a relative --dir is a usage error, got ${res.status} ${res.stdout}`)
    assert.match(String(json.error), /--dir/, `${name}: the error names --dir`)
    assert.equal(existsSync(`${repo}/rel`), false, `${name}: nothing is written under the cwd`)
    assert.equal(existsSync(`${shared}/inbox.jsonl`), false, `${name}: no inbox row is written`)
  }
  // start resolves a relative --dir against the cwd (as ADR-0019 item 18 left it), so a relative dir that holds the plan finds it
  const parent = tmp('gaps-start-')
  const dir = `${parent}/run-dir`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/decisions.md`, '')
  writeFileSync(`${dir}/events.jsonl`, '')
  writePlan(dir, planObj([crew('alpha')]))
  const rel = runCli(FACTORY, 'start', ['--repo', repo, '--dir', 'run-dir', '--stage', '1', '--no-workflow'], parent, extra)
  const abs = runCli(FACTORY, 'start', ['--repo', repo, '--dir', dir, '--stage', '1', '--no-workflow'], parent, extra)
  assert.notEqual(rel.status, 2, `start with a relative --dir must not be a usage error: ${rel.stdout} ${rel.stderr}`)
  assert.equal(rel.status, abs.status, `${rel.stdout} vs ${abs.stdout}`)
  assert.ok(rel.stdout.includes(flat(realpathSync(dir))) || rel.stdout.includes(flat(dir)), `start resolved the relative dir to ${dir}: ${rel.stdout.slice(0, 300)}`)
})

// ---------------------------------------------------------------- item 8: stage green installs missing dependencies

function lockRepo(layout) {
  const repo = realpathSync(mkRepo({ config: { merge: 'sequential', target: 'main' }, files: layout.tracked ?? {} }))
  for (const [rel, text] of Object.entries(layout.untracked ?? {})) {
    mkdirSync(dirname(`${repo}/${rel}`), { recursive: true })
    writeFileSync(`${repo}/${rel}`, text)
  }
  return repo
}
const stubSpawn = (log, status = 0) => (cmd, a, b) => {
  const options = Array.isArray(a) ? b : a
  log.push({ cmd, args: Array.isArray(a) ? a : undefined, argc: [cmd, a, b].filter((x) => x !== undefined).length, options })
  return { status, error: undefined }
}
const needInstall = () => {
  assert.equal(typeof fac.installMissingDeps, 'function', 'bin/factory.ts must export installMissingDeps(cwd, platform, spawn)')
  return fac.installMissingDeps
}

test('stage green runs npm ci for a tracked lockfile whose node_modules is missing', () => {
  const installMissingDeps = needInstall()
  const repo = lockRepo({ tracked: { 'package-lock.json': '{}\n', 'ui/package-lock.json': '{}\n', 'ui/package.json': '{}\n' } })
  const log = []
  const out = installMissingDeps(repo, 'linux', stubSpawn(log))
  assert.equal(log.length, 2, JSON.stringify(log.map((l) => l.options?.cwd)))
  assert.deepEqual(log.map((l) => flat(l.options.cwd)).sort(), [flat(repo), `${flat(repo)}/ui`])
  for (const l of log) {
    assert.equal(l.cmd, 'npm')
    assert.deepEqual(l.args, ['ci'])
  }
  assert.deepEqual(out.map((o) => flat(o.dir)).sort(), [flat(repo), `${flat(repo)}/ui`])
  assert.ok(out.every((o) => o.status === 0))
  // darwin takes the same array form as linux
  const mac = []
  installMissingDeps(repo, 'darwin', stubSpawn(mac))
  assert.deepEqual(mac.map((l) => [l.cmd, l.args]), [['npm', ['ci']], ['npm', ['ci']]])
  // a failed install is reported by its status, not thrown
  const failed = installMissingDeps(repo, 'linux', stubSpawn([], 1))
  assert.deepEqual(failed.map((o) => o.status), [1, 1])
})

test('stage green skips npm ci when node_modules is present or linked', () => {
  const installMissingDeps = needInstall()
  const repo = lockRepo({
    tracked: { 'package-lock.json': '{}\n', 'ui/package-lock.json': '{}\n', 'web/package-lock.json': '{}\n', 'web/package.json': '{}\n' },
    untracked: { 'tool/package-lock.json': '{}\n' },
  })
  mkdirSync(`${repo}/ui/node_modules`, { recursive: true })
  // a linked node_modules (junction: a symlink off win32) counts as present even though its target holds nothing
  const target = tmp('gaps-nm-target-')
  symlinkSync(target, `${repo}/node_modules`, 'junction')
  const log = []
  // web has no node_modules and is tracked: it is the one install; tool/ is untracked, so it is never installed
  const out = installMissingDeps(repo, 'linux', stubSpawn(log))
  assert.deepEqual(log.map((l) => flat(l.options.cwd)), [`${flat(repo)}/web`], 'only the tracked lockfile whose node_modules is missing installs')
  assert.deepEqual(out.map((o) => flat(o.dir)), [`${flat(repo)}/web`])
  mkdirSync(`${repo}/web/node_modules`)
  const again = []
  assert.deepEqual(installMissingDeps(repo, 'linux', stubSpawn(again)), [])
  assert.equal(again.length, 0)
})

test('stage green on win32 runs npm ci through a shell with a fixed argument list', () => {
  const installMissingDeps = needInstall()
  const repo = lockRepo({ tracked: { 'ui/package-lock.json': '{}\n' } })
  const log = []
  const out = installMissingDeps(repo, 'win32', stubSpawn(log))
  assert.equal(log.length, 1)
  const [l] = log
  // one fixed command string with shell: true and no args array (DEP0190), never an npm.cmd spawned bare (CVE-2024-27980, EINVAL)
  assert.equal(l.cmd, 'npm ci')
  assert.equal(l.args, undefined, 'no args array next to shell: true')
  assert.equal(l.argc, 2)
  assert.equal(l.options.shell, true)
  assert.equal(flat(l.options.cwd), `${flat(repo)}/ui`)
  assert.equal(l.options.windowsHide, true)
  assert.deepEqual(out.map((o) => o.status), [0])
})

test('check --expect green installs the missing dependencies before the acceptance test', () => {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' }, files: { 'package-lock.json': '{}\n' } })
  writePlan(env.dir, planObj([crew('x', { acceptanceTest: 'test -d node_modules' })]))
  // a fake npm first on PATH: `npm ci` makes node_modules in its cwd (a node script plus a .cmd shim for win32)
  const bin = tmp('gaps-fakenpm-')
  writeFileSync(`${bin}/npm-stub.js`, "const fs = require('fs')\nif (process.argv[2] === 'ci') fs.mkdirSync('node_modules', { recursive: true })\n")
  writeFileSync(`${bin}/npm`, `#!/usr/bin/env node\nrequire(${JSON.stringify(`${bin}/npm-stub.js`)})\n`)
  chmodSync(`${bin}/npm`, 0o755)
  writeFileSync(`${bin}/npm.cmd`, `@"${process.execPath}" "%~dp0npm-stub.js" %*\r\n`)
  const res = runCli(env.factory, 'check', ['--dir', env.dir, '--repo', env.repo, '--slug', 'x', '--cwd', env.repo, '--expect', 'green'], env.repo, { PATH: `${bin}${delimiter}${process.env.PATH}` })
  assert.equal(res.status, 0, `${res.stdout} ${res.stderr}`)
  assert.equal(existsSync(`${env.repo}/node_modules`), true)
})

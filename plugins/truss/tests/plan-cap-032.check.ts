// Hotfix: `factory.ts plan-cap` changes a running plan's maxParallelCrews through the plan lock, with a decision line.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { REAL_FACTORY, addCrewWorktree, appendEvent, assertOneLine, crew, factorySpawn, mkEnv, mkRun, planObj, readPlan, runCli, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const st = (name: string, fn: () => unknown) => test(name, { timeout: 120000 }, fn)
const crews = () => [crew('a', { status: 'running' }), crew('b', { status: 'running' }), crew('c', { status: 'done' }), crew('d')]
const mkDir = (): string => {
  const d = realpathSync(mkdtempSync(join(os.tmpdir(), 'truss-plancap-')))
  writeFileSync(`${d}/decisions.md`, '')
  writeFileSync(`${d}/events.jsonl`, '')
  return d
}
const cap = (dir: string, flags: string[]) => runCli(REAL_FACTORY, 'plan-cap', ['--dir', dir, ...flags])
const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 400)}; stderr ${String(r.stderr).slice(0, 300)}`

st('plan-cap: raising the cap to 6 rewrites plan.json, logs one decision naming 4 and 6, and reports the running count', () => {
  const dir = mkDir()
  writePlan(dir, planObj(crews()))
  const r = cap(dir, ['--max-parallel-crews', '6', '--reason', 'client ruled the cap up'])
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(assertOneLine(r), { ok: true, from: 4, to: 6, running: 2 })
  assert.equal(readPlan(dir).maxParallelCrews, 6)
  const lines = readFileSync(`${dir}/decisions.md`, 'utf8').split('\n').filter((l) => l.length > 0)
  assert.equal(lines.length, 1, lines.join('\n'))
  assert.match(lines[0], /\b4\b/)
  assert.match(lines[0], /\b6\b/)
  assert.match(lines[0], /client ruled the cap up/)
})

st('plan-cap: 0, 17, abc and a missing or empty reason are usage errors that leave plan.json unchanged', () => {
  const dir = mkDir()
  writePlan(dir, planObj(crews()))
  const before = readFileSync(`${dir}/plan.json`, 'utf8')
  for (const flags of [['--max-parallel-crews', '0', '--reason', 'r'], ['--max-parallel-crews', '17', '--reason', 'r'], ['--max-parallel-crews', 'abc', '--reason', 'r'], ['--max-parallel-crews', '6'], ['--max-parallel-crews', '6', '--reason', '']]) {
    const r = cap(dir, flags)
    assert.equal(r.status, 2, `${flags.join(' ')}: ${say(r)}`)
    assert.equal(typeof assertOneLine(r).error, 'string')
    assert.equal(readFileSync(`${dir}/plan.json`, 'utf8'), before)
  }
  assert.equal(readFileSync(`${dir}/decisions.md`, 'utf8'), '')
})

st('plan-cap: a dir with no plan.json is a usage error', () => {
  const dir = mkDir()
  const r = cap(dir, ['--max-parallel-crews', '6', '--reason', 'r'])
  assert.equal(r.status, 2, say(r))
  assert.equal(typeof assertOneLine(r).error, 'string')
})

// Pattern copied from the 'start cap: free slots = maxParallelCrews minus running crews' case in fixtures/workflow-run/start.cases.ts.
st('plan-cap: start --stage next starts no crew at the old cap of 4 and starts the waiting crew after the cap is raised to 6', () => {
  const env = mkEnv({ useRealPlugin: true })
  const running = ['r1', 'r2', 'r3', 'r4']
  writePlan(env.dir, planObj([...running.map((s) => crew(s, { status: 'running' })), crew('nw')]))
  for (const s of [...running, 'nw']) writeGoal(env.dir, s, {})
  for (const s of running) {
    addCrewWorktree(env.repo, s)
    appendEvent(env.dir, factorySpawn(s, new Date().toISOString()))
  }
  const anchor = mkRun(env.transcripts, 'wf_anchor', [{ label: 'truss-designer', agentType: 'truss:design-engineer', startTs: new Date().toISOString(), endTs: new Date().toISOString() }] as any)
  const slugs = (j: any): string[] => j.truss.crews.map((x: any) => x.slug)
  const before = assertOneLine(env.run('start', { stage: 'next', transcript: anchor.dir }))
  assert.deepEqual(slugs(before), [], 'cap 4 and 4 running leaves no slot')
  const r = env.run('plan-cap', { 'max-parallel-crews': 6, reason: 'client ruled the cap up' })
  assert.equal(r.status, 0, say(r))
  const after = assertOneLine(env.run('start', { stage: 'next', transcript: anchor.dir }))
  assert.deepEqual(slugs(after), ['nw'], 'cap 6 and 4 running leaves a slot')
})

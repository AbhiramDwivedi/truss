// R-84 / ADR-0043: crews may edit the same files and work in parallel; they merge one at a time on the program manager's go-ahead.
// plan-check and owns-extend no longer refuse overlapping owns, in one stage or across goals, and plan-check drops the rule that a
// crew of each stage must own a matched rule file. owns stays each crew's own edit scope (owns-check still refuses outside it).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { REAL_FACTORY, addCrewWorktree, assertOneLine, crew, mkEnv, mkRepo, mkTrussDir, planObj, putFile, readPlan, runCli, writePlan } from './fixtures/workflow-run/harness.ts'

const SHARED = 'plugins/truss/skills/run/SKILL.md'
const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`
const st = (name: string, fn: () => unknown) => test(name, { timeout: 120000 }, fn)

function check(crews: unknown[], over: Record<string, unknown> = {}) {
  const repo = mkRepo({ config: { architecture: 'docs/architecture.md', adr: 'docs/adr' }, files: { [SHARED]: 'skill\n' } })
  const dir = mkTrussDir()
  writePlan(dir, planObj(crews, over))
  return runCli(REAL_FACTORY, 'plan-check', ['--dir', dir, '--repo', repo], repo)
}

st('share-files: two crews in one stage whose owns both list skills/run/SKILL.md pass plan-check with no overlap error', () => {
  const r = check([crew('crew-a', { stage: 1, owns: [SHARED, 'src/a/**'] }), crew('crew-b', { stage: 1, owns: [SHARED, 'src/b/**'] })])
  const j = assertOneLine(r)
  assert.equal(r.status, 0, say(r))
  assert.equal(j.ok, true, say(r))
  assert.ok(!JSON.stringify(j).includes('overlap'), `no overlap error: ${say(r)}`)
})

st('share-files: overlapping globs in one stage pass plan-check', () => {
  const r = check([crew('crew-a', { stage: 1, owns: ['plugins/truss/**'] }), crew('crew-b', { stage: 1, owns: ['plugins/truss/bin/factory.ts'] })])
  assert.equal(r.status, 0, say(r))
  assert.equal(assertOneLine(r).ok, true)
})

st('share-files: crews of two goals owning one file pass plan-check', () => {
  const goals = [{ id: 'second', goal: 'second goal', addedAt: new Date().toISOString(), approval: 'auto', approvedAt: new Date().toISOString() }]
  const r = check([crew('crew-a', { stage: 1, owns: [SHARED], status: 'running' }), crew('crew-c', { stage: 1, goal: 'second', owns: [SHARED] })], { version: 3, goals })
  assert.equal(r.status, 0, say(r))
  assert.equal(assertOneLine(r).ok, true)
})

st('share-files: owns-extend adds a glob another crew of the stage owns', () => {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' }, files: { 'a.txt': 'base\n' } })
  writePlan(env.dir, planObj([crew('s', { owns: ['src/s/**'], status: 'running' }), crew('t', { owns: ['src/t/**'], status: 'running' })]))
  const r = env.run('owns-extend', { slug: 's', glob: 'src/t/x.ts', reason: 'REASON-SHARED' })
  assert.equal(r.status, 0, say(r))
  const j = assertOneLine(r)
  assert.equal(j.ok, true)
  assert.deepEqual(j.owns, ['src/s/**', 'src/t/x.ts'])
  assert.deepEqual(readPlan(env.dir).crews.find((c: any) => c.slug === 's').owns, ['src/s/**', 'src/t/x.ts'])
  assert.ok(readFileSync(`${env.dir}/decisions.md`, 'utf8').includes('REASON-SHARED'), 'the extension is logged')
})

st('share-files: owns stays a crew\'s own edit scope', () => {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' }, files: { 'a.txt': 'base\n' } })
  writePlan(env.dir, planObj([crew('s', { owns: ['src/s/**'], status: 'running' }), crew('t', { owns: ['src/s/**', 'src/t/**'], status: 'running' })]))
  const wt = addCrewWorktree(env.repo, 's')
  putFile(wt, 'src/t/b.ts', 'b\n', 'outside s')
  const r = env.run('owns-check', { slug: 's' })
  assert.equal(r.status, 1, say(r))
  assert.deepEqual(r.json?.outside, ['src/t/b.ts'], say(r))
})

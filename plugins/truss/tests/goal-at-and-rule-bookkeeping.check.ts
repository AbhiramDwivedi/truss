// Two live-run bugs. (A) start: a goal file's `## Acceptance test` wins over plan.json's acceptanceTest, and a difference is
// warned about. (B) owns-check: a base rule file whose only change is its `verified` and `sources` frontmatter keys is bookkeeping.
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { test } from 'node:test'
import { addCrewWorktree, assertOneLine, crew, git, mkEnv, planObj, putFile, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

test('goal at: start puts the goal file acceptance test in force and warns when plan.json differs', () => {
  const env = mkEnv({})
  writePlan(env.dir, planObj([crew('x', { owns: ['src/x/**'], acceptanceTest: 'node --test old-title.check.ts' })]))
  const goal = writeGoal(env.dir, 'x')
  appendFileSync(goal, '\n## Acceptance test\n\nnode --test new-title.check.ts\n')
  const j = assertOneLine(env.run('start', { stage: 'next' }))
  const e = j.truss.crews[0]
  assert.ok(!('acceptanceTest' in e), `the entry carries plan.json's stale command: ${JSON.stringify(e.acceptanceTest)}`)
  const w = (j.warnings as string[]).filter((m) => /\bx\b/.test(m) && /acceptance test/i.test(m) && /plan\.json/.test(m))
  assert.equal(w.length, 1, `expected one acceptance-test warning naming crew x, got ${JSON.stringify(j.warnings)}`)
})

const R = (fm: string, body: string): string => `---\n${fm}---\n\n${body}`
const FM = (verified: string, sources: string[]): string => `paths:\n  - "src/**"\nsources:\n${sources.map((s) => `  - ${s}\n`).join('')}verified: ${verified}\n`
const RULE = '.claude/rules/area.md'

function ruleWorld() {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' }, files: { 'a.txt': 'base\n', [RULE]: R(FM('aaa', ['src/a.ts']), '## Rules\n\n- old\n') } })
  writePlan(env.dir, planObj([crew('s', { owns: ['src/s/**'], status: 'running' })]))
  return { env, wt: addCrewWorktree(env.repo, 's') }
}
function change(wt: string, text: string): void {
  putFile(wt, RULE, text)
  git(wt, ['add', '-A'])
  git(wt, ['commit', '-q', '-m', 'edit rule'])
}
const owns = (env: any) => {
  const r = env.run('owns-check', { slug: 's' })
  return { status: r.status, outside: r.json.outside ?? [] }
}

test('rule bookkeeping: owns-check accepts a base rule file change of only verified', () => {
  const { env, wt } = ruleWorld()
  change(wt, R(FM('bbb', ['src/a.ts']), '## Rules\n\n- old\n'))
  assert.deepEqual(owns(env), { status: 0, outside: [] })
})

test('rule bookkeeping: owns-check accepts a base rule file change of only sources', () => {
  const { env, wt } = ruleWorld()
  change(wt, R(FM('aaa', ['src/a.ts', 'src/b.ts']), '## Rules\n\n- old\n'))
  assert.deepEqual(owns(env), { status: 0, outside: [] })
})

test('rule bookkeeping: owns-check still refuses a base rule file body change', () => {
  const { env, wt } = ruleWorld()
  change(wt, R(FM('bbb', ['src/a.ts']), '## Rules\n\n- new\n'))
  assert.deepEqual(owns(env), { status: 1, outside: [RULE] })
})

test('rule bookkeeping: owns-check still refuses a base rule file change of another frontmatter key', () => {
  const { env, wt } = ruleWorld()
  change(wt, R(FM('aaa', ['src/a.ts']).replace('src/**', 'lib/**'), '## Rules\n\n- old\n'))
  assert.deepEqual(owns(env), { status: 1, outside: [RULE] })
})

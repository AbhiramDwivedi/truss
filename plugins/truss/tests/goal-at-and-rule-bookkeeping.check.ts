// Two live-run bugs. (A) start: a goal file's `## Acceptance test` wins over plan.json's acceptanceTest, and a difference is
// warned about. (B) owns-check: a base rule file whose only change is its `verified` and `sources` frontmatter keys is bookkeeping.
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { test } from 'node:test'
import { addCrewWorktree, assertOneLine, crew, git, mkEnv, planObj, putFile, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const FAIL = 'node -e "process.exit(3)"'
const PASS = 'node -e "process.exit(0)"'
const fenced = (cmd: string): string => `\n## Acceptance test\n\n\`\`\`\n${cmd}\n\`\`\`\n`

function atWorld(section: string | undefined) {
  const env = mkEnv({})
  writePlan(env.dir, planObj([crew('s', { owns: ['src/s/**'], acceptanceTest: FAIL })]))
  const goal = writeGoal(env.dir, 's')
  if (section !== undefined) appendFileSync(goal, section)
  return env
}
const check = (env: any) => env.run('check', { slug: 's', cwd: env.repo, expect: 'green' })

test('goal at: start puts the goal file acceptance test in force, with no warning, and the entry carries none of plan.json', () => {
  const env = mkEnv({})
  writePlan(env.dir, planObj([crew('x', { owns: ['src/x/**'], acceptanceTest: 'node --test old-title.check.ts' })]))
  appendFileSync(writeGoal(env.dir, 'x'), fenced('node --test new-title.check.ts'))
  const j = assertOneLine(env.run('start', { stage: 'next' }))
  const e = j.truss.crews[0]
  assert.ok(!('acceptanceTest' in e), `the entry carries plan.json's stale command: ${JSON.stringify(e.acceptanceTest)}`)
  assert.deepEqual((j.warnings as string[]).filter((m) => /acceptance test/i.test(m)), [])
})

test('goal at: factory check runs the goal file block, not plan.json acceptanceTest', () => {
  const env = atWorld(fenced(PASS))
  const j = assertOneLine(check(env))
  assert.equal(j.ok, true, `the check ran plan.json's failing command instead of the goal file's: ${JSON.stringify(j).slice(0, 300)}`)
})

test('goal at: with no Acceptance test section, factory check keeps plan.json acceptanceTest', () => {
  const env = atWorld(undefined)
  const r = check(env)
  assert.equal(assertOneLine(r).ok, false, 'plan.json holds the failing command and must run')
})

test('goal at: a section with zero fenced blocks or two is refused by check and by start, naming the count and the goal file', () => {
  for (const [section, count] of [['\n## Acceptance test\n\nnode --test x.ts\n', 0], [`${fenced(PASS)}\n\`\`\`\n${PASS}\n\`\`\`\n`, 2]] as const) {
    const env = atWorld(section)
    const c = check(env)
    assert.equal(c.status, 1, c.stdout + c.stderr)
    const cj = assertOneLine(c)
    assert.match(String(cj.why), new RegExp(`found ${count}`))
    assert.match(String(cj.why), /goals\/s\.md/)
    const s = env.run('start', { stage: 'next' })
    const sj = assertOneLine(s)
    assert.equal(sj.refused.length, 1, JSON.stringify(sj.refused))
    assert.match(sj.refused[0].reason, new RegExp(`found ${count}`))
    assert.equal(sj.truss.crews.length, 0)
  }
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

test('rule bookkeeping: knowledge-commit lists a verified-only base rule file under bookkeeping, and a body change not', () => {
  for (const [text, expected] of [[R(FM('bbb', ['src/a.ts']), '## Rules\n\n- old\n'), [RULE]], [R(FM('bbb', ['src/a.ts']), '## Rules\n\n- new\n'), []]] as const) {
    const { env, wt } = ruleWorld()
    const base = git(wt, ['rev-parse', 'HEAD'])
    change(wt, text)
    const head = git(wt, ['rev-parse', 'HEAD'])
    const j = assertOneLine(env.run('knowledge-commit', { slug: 's', sha: head, base, head }))
    assert.deepEqual(j.files, [RULE])
    assert.deepEqual(j.bookkeeping, expected)
  }
})

// Bug C: guardedOf counts a resolver merge as touching a guarded test only when the combined diff has a hunk for it.
const GT = 'tests/t.check.ts'
const lines = (over: Record<number, string> = {}): string => Array.from({ length: 20 }, (_, i) => over[i + 1] ?? `l${i + 1}`).join('\n') + '\n'
function mergeWorld(targetEdit: Record<number, string>) {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' }, files: { 'a.txt': 'base\n', [GT]: lines() } })
  writePlan(env.dir, planObj([crew('s', { owns: ['src/s/**'], status: 'running' })]))
  const wt = addCrewWorktree(env.repo, 's')
  putFile(wt, GT, lines({ 2: 'tester-line' }), 'tester adds a case\n\nTruss-Role: test-writer')
  putFile(env.repo, GT, lines(targetEdit), 'target edits the test')
  return { env, wt }
}
const guardedCheck = (env: any) => {
  const r = env.run('tests-check', { slug: 's' })
  return { status: r.status, json: r.json }
}

test('guarded merge: a resolver merge that git merged cleanly (no hunk in the combined diff) does not touch a guarded test', () => {
  const { env, wt } = mergeWorld({ 19: 'target-line' })
  git(wt, ['merge', 'main', '--no-ff', '-m', 'merge target', '-m', 'Truss-Role: resolver'])
  const r = guardedCheck(env)
  assert.equal(r.status, 0, JSON.stringify(r.json))
  assert.deepEqual(r.json.touched ?? [], [])
})

test('guarded merge: a resolver merge that hand-edits a conflicted guarded test is still refused, listing the commit', () => {
  const { env, wt } = mergeWorld({ 2: 'target-line' })
  git(wt, ['merge', 'main', '--no-ff', '-m', 'merge target', '-m', 'Truss-Role: resolver'], true)
  putFile(wt, GT, lines({ 2: 'hand-edited-by-resolver' }))
  git(wt, ['add', '--', GT])
  git(wt, ['commit', '-q', '-m', 'merge target', '-m', 'Truss-Role: resolver'])
  const r = guardedCheck(env)
  assert.equal(r.status, 1, JSON.stringify(r.json))
  assert.equal(r.json.touched.length, 1)
  assert.equal(r.json.touched[0].commit, git(wt, ['rev-parse', 'HEAD']))
  assert.deepEqual(r.json.touched[0].files, [GT])
})

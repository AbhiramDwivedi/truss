// @ts-nocheck
// truss 0.32.0, bug H: integrate's unparsed-trailer check skips commits the target already holds, as the missing-trailer check does.
// Run with: node --test plugins/truss/tests/integrate-trailers-target-032.check.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addCrewWorktree, assertOneLine, crew, git, head, mkEnv, planObj, putFile, tmp, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const TRAILERS = 'Truss-Crew: s\nTruss-Role: builder'
// a blank line between the Truss lines and a later Co-Authored-By: git does not parse the Truss lines as trailers
const BROKEN = 'Truss-Crew: other\nTruss-Role: builder\n\nCo-Authored-By: A <a@example.com>'
const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`

function world() {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' }, files: { 'a.txt': 'base\n' } })
  writePlan(env.dir, planObj([crew('s', { owns: ['src/s/**'], status: 'running' })]))
  const wt = addCrewWorktree(env.repo, 's')
  return { env, wt }
}
function memberFromTarget(env, name) {
  git(env.repo, ['branch', name, 'main'])
  const mw = `${tmp('i032-member-')}/m`
  git(env.repo, ['worktree', 'add', '-q', mw, name])
  git(mw, ['config', 'user.name', 'T'])
  git(mw, ['config', 'user.email', 't@example.invalid'])
  return mw
}

test('integrate ignores an unparsed trailer on a commit the target already holds', { timeout: 120000 }, () => {
  const { env, wt } = world()
  const start = head(wt)
  // another crew's landed work: the target moves past the crew head
  putFile(env.repo, 'other.txt', 'o\n', `other crew work\n\n${BROKEN}`)
  const landed = head(env.repo)
  const mw = memberFromTarget(env, 'member')
  putFile(mw, 'src/s/new.ts', 'n\n', `member work\n\n${TRAILERS}`)
  assert.ok(git(mw, ['log', '--format=%H', `${start}..member`]).split('\n').includes(landed), 'precondition: the landed commit is in HEAD..member')
  const res = env.run('integrate', { slug: 's', branch: 'member' })
  assert.equal(res.status, 0, say(res))
  assert.equal(res.json?.merged, true, say(res))
  assert.ok(!('trailers' in (res.json ?? {})), say(res))
})

test('integrate still refuses an unparsed trailer on the member\'s own commit', { timeout: 120000 }, () => {
  const { env, wt } = world()
  const start = head(wt)
  putFile(env.repo, 'other.txt', 'o\n', `other crew work\n\n${TRAILERS}`)
  const mw = memberFromTarget(env, 'member')
  const bad = putFile(mw, 'src/s/new.ts', 'n\n', `member work\n\n${BROKEN.replace('other', 's')}`)
  const res = env.run('integrate', { slug: 's', branch: 'member' })
  assert.equal(res.status, 1, say(res))
  const j = assertOneLine(res)
  assert.equal(j.merged, false)
  assert.deepEqual(j.trailers, [`${head(mw)} member work`], say(res))
  assert.equal(head(wt), start, 'nothing merged')
})

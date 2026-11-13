// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss 0.30.0, crew run-lifecycle, goal items 9, 11 and 18. Written from the goal file before the code.
//   9.  `factory goal-check --dir <D> --repo <R> [--goal <id>]` runs the plan's goalCheck (or a goal's own) at the target head in a
//       temporary detached worktree, prints one JSON line {ok, ...} (with the head sha), logs one decision line, never pushes.
//   11. `plan-write` archives a finished run's plan files under another name before it writes the new plan, and refuses while a
//       crew of the old plan is running. decisions.md and usage.jsonl stay shared.
//   18. `plan-args` and `start` default scriptPath to <root>/<project>/<session id>/workflows/scripts/truss-{plan,stage}.js when the
//       session (the truss dir sits under <git common dir>/truss/<sid>/, directly or in a subdir) is found by transcriptsOf.
//
// Run with: node --test plugins/truss/tests/lifecycle-029.check.ts
// Assumptions the goal file leaves open: the goal-check JSON carries the head sha as a string value (key not pinned) and the
// command's output tail as a string value; the archive name is not pinned (found by content).

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { assertOneLine, crew, flat, git, head, mkEnv, mkRun, planObj, putFile, readPlan, runCli, tmp, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

/** Runs a factory command like env.run does, with TRUSS_TRANSCRIPTS_ROOT set (and CLAUDE_CONFIG_DIR cleared) so no case reads ~/.claude. */
function go(env: any, command: string, flags: Record<string, unknown> = {}, root: string = tmp('lc-root-')) {
  const all: Record<string, unknown> = { dir: env.dir, repo: env.repo, ...flags }
  const args: string[] = []
  for (const [k, v] of Object.entries(all)) {
    if (v === null || v === undefined || v === false) continue
    args.push(`--${k}`, ...(v === true ? [] : [String(v)]))
  }
  return runCli(env.factory, command, args, env.repo, { TRUSS_TRANSCRIPTS_ROOT: root, CLAUDE_CONFIG_DIR: '' })
}

const decisionLines = (dir: string): string[] => readFileSync(`${dir}/decisions.md`, 'utf8').split('\n').filter((l) => l.trim() !== '')

// ---------------------------------------------------------------------------------------------------------------
// item 9: goal-check

const CHECK_OK = "const fs = require('node:fs')\nfs.writeFileSync('junk.txt', 'x')\nif (!fs.existsSync('marker.txt')) {\n  console.error('NO-MARKER-HERE')\n  process.exit(4)\n}\nconsole.log('GOALCHECK-SAW-MARKER')\n"
const CHECK_FAIL = "console.log('GOALCHECK-BOOM-OUTPUT')\nprocess.exit(3)\n"

/** A repo whose main checkout sits on `topic` (no marker.txt) while the target branch main holds marker.txt and the check scripts. */
function checkWorld(plan: Record<string, unknown>) {
  const env = mkEnv({ config: { target: 'main' } })
  git(env.repo, ['checkout', '-q', '-b', 'topic'])
  git(env.repo, ['checkout', '-q', 'main'])
  putFile(env.repo, 'check.cjs', CHECK_OK, 'add check')
  putFile(env.repo, 'fail.cjs', CHECK_FAIL, 'add fail check')
  const targetHead = putFile(env.repo, 'marker.txt', 'only on main\n', 'add marker')
  git(env.repo, ['checkout', '-q', 'topic'])
  assert.equal(existsSync(`${env.repo}/marker.txt`), false)
  writePlan(env.dir, planObj([crew('c', { status: 'merged' })], plan))
  writeFileSync(`${env.dir}/decisions.md`, '- 00:00 | seed | none | followed\n')
  return { env, targetHead: targetHead as string }
}

test('goal-check runs goalCheck at the target head, prints JSON and logs a decision line', () => {
  const { env, targetHead } = checkWorld({ goalCheck: 'node check.cjs' })
  const before = decisionLines(env.dir).length
  const res = go(env, 'goal-check')
  assert.equal(res.status, 0, `${res.stdout} ${res.stderr}`)
  const j = assertOneLine(res)
  assert.equal(j.ok, true)
  assert.ok(JSON.stringify(j).includes(targetHead), `the JSON carries the head sha it ran at: ${res.stdout}`)
  assert.equal(decisionLines(env.dir).length, before + 1, 'one new decision line')
})

test('goal-check exits non-zero with the command output when goalCheck fails', () => {
  const goal = { id: 'extra', goal: 'second goal', addedAt: new Date().toISOString(), approval: 'auto', approvedAt: new Date().toISOString(), goalCheck: 'node fail.cjs' }
  const { env } = checkWorld({ version: 3, goalCheck: 'node check.cjs', goals: [goal] })
  const before = decisionLines(env.dir).length
  const control = go(env, 'goal-check')
  assert.equal(control.status, 0, `the top-level check passes: ${control.stdout} ${control.stderr}`)
  const res = go(env, 'goal-check', { goal: 'extra' })
  assert.notEqual(res.status, 0, 'the goal own goalCheck fails the command')
  const j = assertOneLine(res)
  assert.equal(j.ok, false)
  assert.ok(JSON.stringify(j).includes('GOALCHECK-BOOM-OUTPUT'), `the JSON carries the command output: ${res.stdout}`)
  assert.equal(decisionLines(env.dir).length, before + 2, 'each run logs one decision line')
})

test('goal-check runs in a temporary worktree, leaves the main checkout unchanged and never pushes', () => {
  const { env, targetHead } = checkWorld({ goalCheck: 'node check.cjs' })
  const bare = tmp('lc-bare-')
  git(bare, ['init', '-q', '--bare'])
  git(env.repo, ['remote', 'add', 'origin', bare])
  const snap = () => ({
    head: head(env.repo),
    branch: git(env.repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
    refs: git(env.repo, ['for-each-ref']),
    status: git(env.repo, ['status', '--porcelain']),
    worktrees: git(env.repo, ['worktree', 'list', '--porcelain']),
    remoteRefs: git(bare, ['for-each-ref']),
  })
  const before = snap()
  const res = go(env, 'goal-check')
  assert.equal(res.status, 0, `the check saw marker.txt, which only the target branch holds: ${res.stdout} ${res.stderr}`)
  assert.equal(assertOneLine(res).ok, true)
  assert.ok(JSON.stringify(res.json).includes(targetHead))
  assert.deepEqual(snap(), before)
  assert.equal(before.remoteRefs, '', 'the bare remote holds no ref')
  assert.equal(existsSync(`${env.repo}/junk.txt`), false, 'the check wrote nothing into the main checkout')
})

// ---------------------------------------------------------------------------------------------------------------
// item 11: a second run in one session dir

const PLAN_JSON = JSON.stringify(planObj([crew('arch', { stage: 0, verdict: 'design' })], { approval: 'client', approvedAt: null }), null, 2)
const messageOf = () => `Here is the plan.\n\n\`\`\`\`json plan.json\n${PLAN_JSON}\n\`\`\`\`\n\n\`\`\`\`markdown plan.md\n# The new plan\n\nBody.\n\`\`\`\`\n`

function planRun(env: any): string {
  return mkRun(env.transcripts, 'wf_plan', [{ id: 'aarch', label: 'truss-designer', agentType: 'truss:design-engineer', metaModel: 'opus', result: messageOf(), startTs: '2026-10-29T10:00:00.000Z' }]).dir
}

const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(`${dir}/${n}`).isDirectory() ? walk(`${dir}/${n}`) : [`${dir}/${n}`]))
const OLD_MD = '# The old plan\n\nOLD-PLAN-BODY\n'
const USAGE = '{"ts":"2026-10-29T09:00:00.000Z","note":"usage-row"}\n'

function secondRunWorld(status: string) {
  const env = mkEnv()
  writePlan(env.dir, planObj([crew('old', { status })], { goal: 'old goal' }))
  writeFileSync(`${env.dir}/plan.md`, OLD_MD)
  writeFileSync(`${env.dir}/decisions.md`, '- 00:00 | old decision | none | followed\n')
  writeFileSync(`${env.dir}/usage.jsonl`, USAGE)
  return env
}

test('a second run in one session dir keeps the earlier run plan files', () => {
  const env = secondRunWorld('merged')
  const oldPlan = readFileSync(`${env.dir}/plan.json`, 'utf8')
  const res = go(env, 'plan-write', { transcript: planRun(env), label: 'truss-designer' })
  assert.equal(res.status, 0, `${res.stdout} ${res.stderr}`)
  assert.equal(assertOneLine(res).written, true)
  assert.equal(readPlan(env.dir).crews[0].slug, 'arch', 'the new plan is written')
  assert.equal(readPlan(env.dir).approvedAt, null)
  assert.match(readFileSync(`${env.dir}/plan.md`, 'utf8'), /The new plan/)
  const kept = walk(env.dir).map(flat).filter((p) => p !== `${env.dir}/plan.json` && p !== `${env.dir}/plan.md`)
  assert.ok(kept.some((p) => readFileSync(p, 'utf8') === oldPlan), 'the old plan.json is readable under another name')
  assert.ok(kept.some((p) => readFileSync(p, 'utf8') === OLD_MD), 'the old plan.md is readable under another name')
  assert.ok(readFileSync(`${env.dir}/decisions.md`, 'utf8').startsWith('- 00:00 | old decision | none | followed\n'), 'decisions.md stays shared, in place')
  assert.equal(readFileSync(`${env.dir}/usage.jsonl`, 'utf8'), USAGE, 'usage.jsonl stays shared, in place')
})

test('a second run is refused while a crew of the earlier plan is running', () => {
  const env = secondRunWorld('running')
  const oldPlan = readFileSync(`${env.dir}/plan.json`, 'utf8')
  const files = walk(env.dir).sort()
  const res = go(env, 'plan-write', { transcript: planRun(env), label: 'truss-designer' })
  assert.notEqual(res.status, 0)
  const j = assertOneLine(res)
  assert.equal(j.written, false)
  assert.match(String(j.reason), /running/, `the refusal names the running crew, not only the approval: ${res.stdout}`)
  assert.equal(readFileSync(`${env.dir}/plan.json`, 'utf8'), oldPlan, 'the old plan is untouched')
  assert.equal(readFileSync(`${env.dir}/plan.md`, 'utf8'), OLD_MD)
  assert.deepEqual(walk(env.dir).sort(), files, 'nothing was archived or written')
})

// ---------------------------------------------------------------------------------------------------------------
// item 18: the session scripts dir is the default scriptPath

/** A repo and a truss dir <common>/truss/<sid>[/<sub>], with the session's main transcript under a fixture root. */
function sessionWorld(sub = '') {
  const env = mkEnv()
  const sid = randomUUID()
  const dir = `${flat(git(env.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']))}/truss/${sid}${sub}`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/decisions.md`, '')
  writeFileSync(`${dir}/events.jsonl`, '')
  const root = tmp('lc-root-')
  mkdirSync(`${root}/-proj`, { recursive: true })
  writeFileSync(`${root}/-proj/${sid}.jsonl`, '{"type":"user"}\n')
  env.dir = dir
  return { env, sid, root, scripts: `${root}/-proj/${sid}/workflows/scripts` }
}

const brief = (env: any): string => {
  const p = `${env.dir}/brief.md`
  writeFileSync(p, 'Build the thing.\n')
  return p
}

test('plan-args defaults scriptPath to the session scripts dir when the session is found', () => {
  for (const sub of ['', '/wave4']) {
    const { env, root, scripts } = sessionWorld(sub)
    const res = go(env, 'plan-args', { 'brief-file': brief(env) }, root)
    assert.equal(res.status, 0, res.stderr)
    const got = assertOneLine(res).truss.scriptPath
    assert.equal(flat(got), `${scripts}/truss-plan.js`, `session dir suffix "${sub}"`)
    assert.ok(readFileSync(got).equals(readFileSync(`${env.plugin}/workflows/plan.js`)), 'a byte copy of the plugin script')
  }
  // no session found (no transcript, or a truss dir outside <common>/truss): the default stays the plugin script
  const { env, root } = sessionWorld()
  const lone = mkEnv()
  const plain = assertOneLine(go(lone, 'plan-args', { 'brief-file': brief(lone) }, root))
  assert.equal(flat(plain.truss.scriptPath), `${lone.plugin}/workflows/plan.js`)
  const noTranscript = assertOneLine(go(env, 'plan-args', { 'brief-file': brief(env) }, tmp('lc-empty-')))
  assert.equal(flat(noTranscript.truss.scriptPath), `${env.plugin}/workflows/plan.js`)
})

test('start defaults scriptPath to the session scripts dir and --scripts-dir overrides it', () => {
  const { env, root, scripts } = sessionWorld('/wave4')
  writePlan(env.dir, planObj([crew('wf')]))
  writeGoal(env.dir, 'wf')
  const res = go(env, 'start', { stage: 'next' }, root)
  assert.equal(res.status, 0, `${res.stdout} ${res.stderr}`)
  const got = assertOneLine(res).truss.scriptPath
  assert.equal(flat(got), `${scripts}/truss-stage.js`)
  assert.ok(readFileSync(got).equals(readFileSync(`${env.plugin}/workflows/stage.js`)), 'a byte copy of the plugin script')

  const other = sessionWorld('/wave4')
  writePlan(other.env.dir, planObj([crew('wf')]))
  writeGoal(other.env.dir, 'wf')
  const own = tmp('lc-own-')
  const over = go(other.env, 'start', { stage: 'next', 'scripts-dir': own }, other.root)
  assert.equal(over.status, 0, `${over.stdout} ${over.stderr}`)
  assert.equal(flat(assertOneLine(over).truss.scriptPath), `${own}/truss-stage.js`)
  assert.equal(existsSync(other.scripts), false, 'the override leaves the session scripts dir alone')
})

// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// The refusal event (P24): which party refused a tool call, counted without reading any body.
//
// Run with: node --test tests/refusals.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as reg from '../hooks/register.ts'
import { validateEvent } from './fixtures/workflow-run/harness.ts'

const { refusalOf, refusalLine, commandShape, HANDBACK_REFUSAL, MODEL_REFUSAL, REFUSAL_CATEGORY_MAX } = reg

const WT = '/home/u/p/.claude/worktrees/agent-abc'
// the worktree guard's words as Claude Code 2.1.310 returns them, as an errored result
const guard = (reason: string) => ({
  isError: true,
  text: `This agent is isolated in the worktree ${WT}, but this command ${reason}. Refusing to run it — a worktree-isolated agent's git operations must target its own worktree. Split it into plain, separate commands and run them from ${WT}.`,
})
const line = (tool, input, result, hasPlan = true) => refusalLine(tool, input, result, 'crew-a', 'builder-1', hasPlan)

test('truss: its own deny is source truss, the rule up to its first sentence, names taken out', () => {
  assert.deepEqual(refusalOf({ deny: HANDBACK_REFUSAL }), { source: 'truss', category: 'that hand-back is too short to be a report' })
  assert.equal(refusalOf({ deny: MODEL_REFUSAL }).source, 'truss')
  const named = refusalOf({ deny: '[truss] Refused: more than one live agent is named "builder-2", in different crews. Address it by its agent id.' })
  assert.equal(named.category, 'more than one live agent is named <name>, in different crews')
  assert.equal(refusalOf({ deny: "[truss] Refused: truss agents run in a Workflow only from the plugin's plan.js and stage.js" }).category, "truss agents run in a Workflow only from the plugin's plan.js and stage.js")
})

test('worktree guard: the reason phrase, its paths and variable names taken out', () => {
  assert.deepEqual(refusalOf(guard('is too complex to verify that it stays inside the worktree')), { source: 'worktree-guard', category: 'is too complex to verify that it stays inside the worktree' })
  const cd = refusalOf(guard('changes directory to the shared checkout (/home/u/p) before running git'))
  assert.equal(cd.category, 'changes directory to the shared checkout (<path>) before running git')
  const v = refusalOf(guard('runs sed with a value computed at runtime (the variable T)'))
  assert.equal(v.category, 'runs sed with a value computed at runtime (a variable)')
})

test('classifier: the bracketed category, or no verdict', () => {
  const r = { isError: true, text: 'Permission for this action has been denied by the Claude Code auto mode classifier. Reason: [Self-Modification] writes the agent settings.' }
  assert.deepEqual(refusalOf(r), { source: 'classifier', category: 'Self-Modification' })
  const nv = { isError: true, text: 'The auto mode classifier gave no verdict on the safety of Write, so the call was not run.' }
  assert.deepEqual(refusalOf(nv), { source: 'classifier', category: 'no verdict' })
})

test('permission: a denied rule or the person saying no', () => {
  assert.deepEqual(refusalOf({ isError: true, text: 'Permission to use Bash with command rm -rf x has been denied.' }), { source: 'permission', category: 'denied' })
  assert.deepEqual(refusalOf({ isError: true, text: "The user doesn't want to proceed with this tool use." }), { source: 'permission', category: 'the person said no' })
})

test('other: another plugin\'s deny counts; an ordinary failed tool or a good result does not', () => {
  assert.equal(refusalOf({ deny: 'blocked by policy plugin' }).source, 'other')
  assert.equal(refusalOf({ isError: true, text: 'Exit code 1\nnpm ERR! missing script' }), undefined)
  assert.equal(refusalOf({ result: { stdout: '' }, text: 'ok' }), undefined)
  assert.equal(refusalOf(undefined), undefined)
  assert.equal(refusalOf({ isError: true, text: '' }), undefined)
})

test('a category never runs past REFUSAL_CATEGORY_MAX', () => {
  const r = refusalOf({ deny: 'x'.repeat(500) })
  assert.equal(r.category.length, REFUSAL_CATEGORY_MAX)
})

test('commandShape: the first word and the kinds of part, never the text', () => {
  assert.deepEqual(commandShape("cat > a.ts <<'EOF'\nconst secret = 1\nEOF"), { program: 'cat', shape: ['heredoc'] })
  assert.deepEqual(commandShape("mkdir -p d && cat > d/a <<'EOF'\nx\nEOF"), { program: 'mkdir', shape: ['heredoc', 'compound'] })
  assert.deepEqual(commandShape('cd ui && npm test'), { program: 'cd', shape: ['compound', 'cd'] })
  assert.deepEqual(commandShape('sed -n 1,5p $T'), { program: 'sed', shape: ['var'] })
  assert.deepEqual(commandShape('for f in a b; do echo $f; done'), { program: 'for', shape: ['compound', 'var', 'loop'] })
  assert.deepEqual(commandShape('/usr/bin/git log | head'), { program: 'git', shape: ['pipe'] })
  assert.deepEqual(commandShape('FOO=1 node x'), { program: null, shape: [] })
  assert.deepEqual(commandShape(undefined), { program: null, shape: [] })
})

test('refusalLine: no plan, no line; a refused Bash call names its program, never its body; every line validates', () => {
  assert.equal(line('Bash', { command: 'ls' }, guard('is too complex to verify that it stays inside the worktree'), false), null)
  assert.equal(line('Bash', { command: 'ls' }, { result: {}, text: 'a' }), null)
  const body = "python3 -I - <<'EOF'\nimport subprocess; subprocess.run(['git', 'push', 'TOPSECRET'])\nEOF"
  const l = line('Bash', { command: body }, guard('feeds python text naming git in a plain command'))
  assert.deepEqual(l, { event: 'refusal', crew: 'crew-a', agent: 'builder-1', tool: 'Bash', source: 'worktree-guard', category: 'feeds python text naming git in a plain command', program: 'python3', shape: ['heredoc'] })
  assert.ok(!JSON.stringify(l).includes('TOPSECRET'))
  const w = line('Write', { file_path: '/x', content: 'TOPSECRET' }, { isError: true, text: 'The auto mode classifier gave no verdict on the safety of Write.' })
  assert.deepEqual({ program: w.program, shape: w.shape, source: w.source }, { program: null, shape: [], source: 'classifier' })
  assert.ok(!JSON.stringify(w).includes('TOPSECRET'))
  for (const ev of [l, w, line('Agent', {}, { deny: HANDBACK_REFUSAL }), line('Task', {}, { deny: 'x'.repeat(300) })]) {
    const { event, ...fields } = ev
    assert.deepEqual(validateEvent({ v: 1, ts: '2026-10-31T07:00:00.000Z', event, ...fields }), [])
  }
})

test('schema: a refusal with a body field, an unknown source or a repeated shape is refused', () => {
  const ok = { v: 1, ts: '2026-10-31T07:00:00.000Z', event: 'refusal', crew: 'main', agent: 'main', tool: 'Bash', source: 'worktree-guard', category: 'x', program: 'cat', shape: ['heredoc'] }
  assert.deepEqual(validateEvent(ok), [])
  assert.notDeepEqual(validateEvent({ ...ok, command: 'cat > f' }), [])
  assert.notDeepEqual(validateEvent({ ...ok, source: 'hook' }), [])
  assert.notDeepEqual(validateEvent({ ...ok, shape: ['heredoc', 'heredoc'] }), [])
  assert.notDeepEqual(validateEvent({ ...ok, shape: ['body'] }), [])
})

test('wiring: every deny the hooks return goes through refuse(), and the catch-all reads every answer', () => {
  const src = readFileSync(new URL('../hooks/register.ts', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('export const register: Register'))
  // a deny returned bare from a hook would not be counted; the fetch gate's never fires today and logs its own line
  const bare = [...body.matchAll(/return \{ deny: [^}]*\}/g)].map(m => m[0])
  assert.deepEqual(bare, ['return { deny: verdict.reason }'])
  for (const site of ['refuse($, e, { deny: decided.reason })', 'refuse($, e, caller.refused)', 'refuse($, e, spent)', 'refuse($, e, { deny: HANDBACK_REFUSAL })']) assert.ok(body.includes(site), site)
  assert.equal([...body.matchAll(/return refuse\(\$, e, refused\)/g)].length, 3)
  assert.ok(body.includes('return answered(await next(e))') && body.includes('return answered(passed)'))
})

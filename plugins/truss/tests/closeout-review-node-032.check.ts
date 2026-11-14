// @ts-nocheck
// truss 0.32.0, closeout crew: findings of the after-the-fact QC and review of the two hand-merged 0.30.0 crews, Node side
// (run-lifecycle `git diff 0d0047032d7e 09423cbf` and crew-decisions `git diff 29953ee2^1 29953ee2`, now in bin/factory/*.ts and bin/inbox.ts).
// Each case pins one finding of plugins/truss/docs/goals/0.32.0-closeout.md and fails until the finding is fixed.
//
// Run with: node --test --test-reporter=tap plugins/truss/tests/closeout-review-node-032.check.ts

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { REAL_PLUGIN, assertOneLine, crew, flat, mkEnv, mkRepo, mkRun, planObj, runCli, tmp, validateEvent, writePlan } from './fixtures/workflow-run/harness.ts'

const FACTORY = `${REAL_PLUGIN}/bin/factory.ts`
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(`${dir}/${n}`).isDirectory() ? walk(`${dir}/${n}`) : [`${dir}/${n}`]))

// ---------------------------------------------------------------------------------------------------------------
// QC pass, R-95 (run-lifecycle): a second run in one session dir has a supported start. plan-write archives plan.json and plan.md of
// the finished run, but the run's per-crew state lives under <dir>/crews/<slug>/ and <dir>/crew-decisions/ and stays where the new
// run's crew of the same slug reads it: its reply checkpoint and its crew decisions.

const NEW_PLAN = JSON.stringify(planObj([crew('arch', { stage: 0, verdict: 'design' })], { approval: 'client', approvedAt: null }), null, 2)
const NEW_MESSAGE = `Here is the plan.\n\n\`\`\`\`json plan.json\n${NEW_PLAN}\n\`\`\`\`\n\n\`\`\`\`markdown plan.md\n# The new plan\n\nBody.\n\`\`\`\`\n`

test('closeout-review-node: a second run does not inherit the reply checkpoint or crew decisions of the archived run for a crew of the same slug', () => {
  const env = mkEnv()
  writePlan(env.dir, planObj([crew('arch', { status: 'merged' })], { goal: 'old goal' }))
  writeFileSync(`${env.dir}/plan.md`, '# The old plan\n')
  // the old run's crew passed its reply checkpoint and made one crew decision
  mkdirSync(`${env.dir}/crews/arch`, { recursive: true })
  writeFileSync(`${env.dir}/crews/arch/checkpoint.json`, '{"ts":"2026-10-29T10:00:00.000Z"}\n')
  const oldDecision = JSON.stringify({ id: 'd-arch-1', ts: '2026-10-29T10:00:00.000Z', crew: 'arch', task: 'build', question: 'OLD-RUN-QUESTION', answer: 'OLD-RUN-ANSWER', by: 'product-owner' }) + '\n'
  mkdirSync(`${env.dir}/crew-decisions`, { recursive: true })
  writeFileSync(`${env.dir}/crew-decisions/d-arch-1.json`, oldDecision)
  // control: before the second plan-write the old run's crew shows both
  const before = assertOneLine(env.run('decisions', {}, ['--crew', 'arch']))
  assert.equal(before.checkpoint, true, 'control: the old run crew has passed its checkpoint')
  assert.equal(before.decisions.length, 1, 'control: the old run crew decision is listed')

  const run = mkRun(env.transcripts, 'wf_plan', [{ id: 'aarch', label: 'truss-designer', agentType: 'truss:design-engineer', metaModel: 'opus', result: NEW_MESSAGE, startTs: '2026-10-29T10:00:00.000Z' }]).dir
  const w = env.run('plan-write', { transcript: run, label: 'truss-designer' })
  assert.equal(w.status, 0, `${w.stdout} ${w.stderr}`)
  assert.equal(assertOneLine(w).written, true)

  const after = assertOneLine(env.run('decisions', {}, ['--crew', 'arch']))
  assert.equal(after.checkpoint, false, 'the new run crew arch has not passed a reply checkpoint: that one belongs to the archived run')
  assert.deepEqual(after.decisions.map((d) => d.id), [], 'the new run lists no crew decision of the archived run')
  // the archived run's decision stays readable under the dir, only not where the new run reads it
  assert.ok(walk(env.dir).some((p) => readFileSync(p, 'utf8') === oldDecision && !p.endsWith('/crew-decisions/d-arch-1.json')), 'the old crew decision is kept under another path')
})

// ---------------------------------------------------------------------------------------------------------------
// Reviewer pass, truss-plugin-node standard 12 (crew-decisions): a new inbox kind. `pm-question` is in bin/inbox.ts KINDS, but the
// escalate event it writes is not valid against docs/events.schema.json, and docs/state.schema.json's inboxKind lacks it.

function sessionWorld() {
  const repo = flat(mkRepo({ config: { architecture: 'docs/architecture.md', adr: 'docs/adr' } }))
  const dir = `${repo}/.git/truss/sess-${randomUUID().slice(0, 8)}`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/events.jsonl`, '')
  writeFileSync(`${dir}/decisions.md`, '')
  writePlan(dir, planObj([crew('crew-a')]))
  return { repo, dir, troot: tmp('closeout-rn-tr-') }
}

test('closeout-review-node: the escalate event of a pm-question item is valid against events.schema.json and state.schema.json lists the kind', () => {
  const w = sessionWorld()
  const r = runCli(FACTORY, 'escalate', ['--repo', w.repo, '--dir', w.dir, '--kind', 'pm-question', '--title', 'which currency', '--crew', 'crew-a', '--blocking'], w.repo, { TRUSS_TRANSCRIPTS_ROOT: w.troot })
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`)
  const rows = readFileSync(`${w.dir}/events.jsonl`, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)).filter((e) => e.event === 'escalate')
  assert.equal(rows.length, 1, 'escalate wrote one escalate event')
  assert.equal(rows[0].kind, 'pm-question')
  assert.deepEqual(validateEvent(rows[0]), [], 'the escalate event of a pm-question item is a valid event')
  const state = JSON.parse(readFileSync(path.join(REAL_PLUGIN, 'docs', 'state.schema.json'), 'utf8'))
  assert.ok(state.$defs.inboxKind.enum.includes('pm-question'), 'state.schema.json inboxKind lists pm-question')
})

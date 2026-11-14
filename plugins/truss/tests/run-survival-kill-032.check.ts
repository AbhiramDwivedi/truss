// @ts-nocheck
// Regression cases for run-survival (R-141, ADR-0052 Decision 1), written red on head 5515d86d before the fix.
// Case 1: the PM session dies inside `start`, after claimedWorktree set the crew `running` and before the spawn
//   event. The state that kill leaves is rebuilt directly: plan.json `running`, no spawn event, no worktree, no
//   branch. A kill timed against git is racy, so the test plants the state the kill produced. A new session must be
//   able to get the crew started again by some start form.
// Case 2: the resume instructions must say which --transcript a new session passes (its own Workflow run dir).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { crew, flat, mkRepo, planObj, readEvents, readPlan, REAL_FACTORY, runCli, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`

test('a crew left running by a start that died before its spawn event can be started again by a new session', () => {
  const root = flat(realpathSync(mkdtempSync(join(tmpdir(), 'rs032k-tr-'))))
  const repo = mkRepo({ config: { merge: 'sequential', target: 'main' } })
  try {
    const dir = `${repo}/.git/truss/s-old`
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/decisions.md`, '')
    writeFileSync(`${dir}/events.jsonl`, '')
    writePlan(dir, planObj([crew('c1', { stage: 1, status: 'running' })], { approvedAt: new Date(Date.now() - 3_600_000).toISOString() }))
    writeGoal(dir, 'c1', {})
    const newRun = `${root}/proj/wf_new`
    mkdirSync(newRun, { recursive: true })
    const env = { TRUSS_TRANSCRIPTS_ROOT: root }
    const first = runCli(REAL_FACTORY, 'start', ['--repo', repo, '--dir', dir, '--stage', 'next', '--transcript', newRun], repo, env)
    assert.equal(first.status, 0, say(first))
    const out = first.json?.truss ?? first.json ?? {}
    const started = (out.crews ?? []).some((e: any) => e.slug === 'c1')
    const stale = (first.json?.stale ?? out.stale ?? []).some((e: any) => e.slug === 'c1')
    assert.ok(started || stale, `the dead start's crew c1 is neither started nor listed stale; ${say(first)}`)
    if (!started) {
      const second = runCli(REAL_FACTORY, 'start', ['--repo', repo, '--dir', dir, '--slug', 'c1', '--resume', 'stale', '--transcript', newRun], repo, env)
      assert.equal(second.status, 0, `--resume stale refuses the dead start's crew; ${say(second)}`)
    }
    const spawns = readEvents(dir).filter((e) => e.event === 'spawn' && e.type === 'workflow-crew' && e.by === 'factory' && e.crew === 'c1')
    assert.ok(spawns.length >= 1, `no start record for c1 after recovery; plan status ${readPlan(dir).crews[0].status}`)
    const wt = spawnSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8', windowsHide: true }).stdout
    assert.match(wt, /truss-c1/, `no truss-c1 worktree after recovery: ${wt}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
})

test('the run skill says a new session passes its own Workflow run dir as --transcript when it resumes a stale crew', () => {
  const text = readFileSync(new URL('../skills/run/SKILL.md', import.meta.url), 'utf8').split('\n')
  const at = text.findIndex((l) => l.includes('find-run'))
  assert.ok(at >= 0, 'SKILL.md mentions find-run')
  const block = text.slice(at, at + 12).join('\n')
  assert.match(block, /--resume stale[^\n]*--transcript|--transcript[^\n]*--resume stale/, 'the resume form carries --transcript')
  assert.match(block, /(new|this) session'?s? (own )?(Workflow )?run dir|run dir of (the|this) (new |current )?session/i, 'it names which run dir T is')
})

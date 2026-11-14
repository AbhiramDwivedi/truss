// @ts-nocheck
// qc-4 bug: a goalCheck that outlives KILL_GRACE_MS after SIGTERM (it traps SIGTERM and runs ~4 s on) is stopped by the run limit.
// The caller must still leave no registered worktree and no temp dir, and decisions.md must hold one stopped-by-the-run-limit line.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertOneLine, crew, git, mkEnv, planObj, putFile, runCli, tmp, writePlan } from './fixtures/workflow-run/harness.ts'

test('heavy grace leak: a goal-check slower than KILL_GRACE_MS to die leaves no worktree, no temp dir and one decision line', { timeout: 90000 }, () => {
  const scratch = tmp('hgl-032-')
  const pidFile = join(scratch, 'pid')
  const tmpRoot = tmp('hgl-032-tmpdir-')
  const env = mkEnv({ config: { target: 'main' } })
  putFile(env.repo, 'slow.cjs', "require('node:fs').writeFileSync(process.argv[2], String(process.pid))\nprocess.on('SIGTERM', () => setTimeout(() => process.exit(143), 4000))\nsetTimeout(() => {}, 600000)\n", 'add slow check')
  writePlan(env.dir, planObj([crew('c', { status: 'merged' })], { goalCheck: `node slow.cjs ${pidFile}` }))
  writeFileSync(`${env.dir}/decisions.md`, '- 00:00 | seed | none | followed\n')
  const before = git(env.repo, ['worktree', 'list', '--porcelain'])
  try {
    const res = runCli(env.factory, 'goal-check', ['--dir', env.dir, '--repo', env.repo], env.repo, {
      TRUSS_TRANSCRIPTS_ROOT: tmp('hgl-032-root-'),
      CLAUDE_CONFIG_DIR: '',
      TMPDIR: tmpRoot,
      TRUSS_HEAVY_RUN_MS: '2000',
      TRUSS_HEAVY_ATTACH_MS: '40000',
    })
    const j = assertOneLine(res)
    assert.equal(j.timedOut, true, res.stdout)
    assert.equal(git(env.repo, ['worktree', 'list', '--porcelain']), before, 'a goal-check worktree is still registered')
    const left = readdirSync(tmpRoot).filter((n) => n.startsWith('truss-goalcheck-'))
    assert.deepEqual(left, [], 'a goal-check temp dir is left')
    const lines = readFileSync(`${env.dir}/decisions.md`, 'utf8').split('\n').filter((l) => /stopped by the run limit/.test(l))
    assert.equal(lines.length, 1, readFileSync(`${env.dir}/decisions.md`, 'utf8'))
  } finally {
    try {
      if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
    } catch {}
  }
})

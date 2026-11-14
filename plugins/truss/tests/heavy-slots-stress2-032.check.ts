// @ts-nocheck
// 0.32.0 heavy-slots stress findings 2, regression cases written red first against the real CLI: (1) a goal-check the run limit stops
// leaves no worktree, logs one decision line and reports timedOut; (2) a TRUSS_HEAVY_RUN_MS of 2^31 ms or more does not stop the command at once.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertOneLine, crew, git, mkEnv, planObj, putFile, runCli, tmp, writePlan } from './fixtures/workflow-run/harness.ts'

const decisionLines = (dir: string): string[] => readFileSync(`${dir}/decisions.md`, 'utf8').split('\n').filter((l) => l.trim() !== '')
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e.code === 'EPERM'
  }
}
const sampleFile = (): string => {
  const p = join(tmp('hs-stress2-032-sample-'), 'ok.json')
  writeFileSync(p, JSON.stringify({ freeMB: 9000, totalMB: 16000 }))
  return p
}

test('heavy stress 3: a goal-check stopped by the run limit removes its worktree, logs a decision and reports timedOut', { timeout: 60000 }, () => {
  const scratch = tmp('hs-stress2-032-slow-')
  const pidFile = join(scratch, 'pid')
  const env = mkEnv({ config: { target: 'main' } })
  putFile(env.repo, 'slow.cjs', "require('node:fs').writeFileSync(process.argv[2], String(process.pid))\nsetTimeout(() => {}, 600000)\n", 'add slow check')
  writePlan(env.dir, planObj([crew('c', { status: 'merged' })], { goalCheck: `node slow.cjs ${pidFile}` }))
  writeFileSync(`${env.dir}/decisions.md`, '- 00:00 | seed | none | followed\n')
  const worktrees = git(env.repo, ['worktree', 'list', '--porcelain'])
  const before = decisionLines(env.dir).length
  try {
    const res = runCli(env.factory, 'goal-check', ['--dir', env.dir, '--repo', env.repo], env.repo, {
      TRUSS_TRANSCRIPTS_ROOT: tmp('hs-stress2-032-root-'),
      CLAUDE_CONFIG_DIR: '',
      TRUSS_SAMPLE: sampleFile(),
      TRUSS_HEAVY_RUN_MS: '2000',
      TRUSS_HEAVY_ATTACH_MS: '30000',
    })
    const j = assertOneLine(res)
    assert.equal(j.timedOut, true, `the caller sees that the run limit stopped the goalCheck: ${res.stdout}`)
    assert.equal(git(env.repo, ['worktree', 'list', '--porcelain']), worktrees, 'the temporary worktree is removed and pruned')
    assert.equal(decisionLines(env.dir).length, before + 1, 'one decision line is logged for the stopped goalCheck')
  } finally {
    try {
      if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
    } catch {}
  }
})

test('heavy stress 4: a TRUSS_HEAVY_RUN_MS of 2^31 ms or more does not stop the command at once', { timeout: 60000 }, () => {
  const env = mkEnv({ useRealPlugin: true, config: { merge: 'sequential', target: 'main', heavySlots: 1 } })
  const res = runCli(
    env.factory,
    'heavy',
    ['--dir', env.dir, '--repo', env.repo, '--slug', 'p', '--label', 'p-suite', '--cwd', env.repo, '--', process.execPath, '-e', "setTimeout(()=>console.log('SUITE-DONE'),3000)"],
    env.repo,
    { TRUSS_SAMPLE: sampleFile(), TRUSS_HEAVY_ATTACH_MS: '30000', TRUSS_HEAVY_RUN_MS: '3000000000' },
  )
  const j = assertOneLine(res)
  assert.notEqual(j.heavy?.timedOut, true, `a limit of 3000000000 ms is no limit, not 1 ms: ${res.stdout}`)
  assert.equal(res.status, 0, res.stdout)
  assert.match(String(j.tail), /SUITE-DONE/)
})

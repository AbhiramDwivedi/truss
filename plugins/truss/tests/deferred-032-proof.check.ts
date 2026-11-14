// 0.32.0 crew deferred-fixes (R-138): report-0.31.0.md said the goalCheck pending test and some fixer tests were proved failing-first by
// reasoning, not by a run against the old code, where the old code would hang. This case runs them against the old code.
//
// The old code is the tree of commit dccb501f^ (the parent of the commit that made goalCheck a heavy background job), built in a mkdtemp
// dir with a private git index and `git checkout-index`, so it needs no network, no sibling checkout, no worktree registration and no tar.
// The tests are the files as dccb501f committed them, dropped over the old tree's own tests, so they run against the old bin/ and
// workflows/ and not against this checkout's. The old goal-check ran in the foreground and waited out TRUSS_GOALCHECK_TIMEOUT_MS
// (600 s by default) before it killed its tree; the run sets it to 3 s so the old code's hang is cut short by a test timeout of its own,
// as the old kill reaches the whole process tree and leaves nothing behind. A control runs the same titles on this checkout and
// requires them to pass, so a failure above is about the old code and not about the harness.
//
// TRUSS_CONTRACT_ROOT is not read by these tests (it belongs to the contract tests that read one producer file); the old tree takes
// its place here, as the root the nested `node --test` runs from.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { REAL_PLUGIN, flat } from './fixtures/workflow-run/harness.ts'

const FIX = 'dccb501f'
const REPO = flat(path.resolve(REAL_PLUGIN, '..', '..'))
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// What each title's failure on the old code looks like: that title's own failed assertion of the new behaviour, named by its message
// (or its expected/actual) and by the line of the test file as dccb501f committed it. Any other failure, an import error included,
// is not the reported reason and fails this case.
const CASES: { file: string; title: string; symptom: RegExp[] }[] = [
  {
    file: 'tests/lifecycle-029.check.ts',
    title: 'goal-check runs as a background heavy job: a wait that runs out says it is still running in one line, kills nothing, and the same line collects the result',
    // assert.equal(j.pending, true): the old goal-check waited in the foreground and printed no pending flag
    symptom: [/\+ undefined\s*\n\s*- true/, /lifecycle-029\.check\.ts:95:\d+\)/],
  },
  {
    file: 'tests/heavy-031.check.ts',
    title: 'an acceptance test that is only npm test runs the whole suite, so it takes the heavy slot',
    // the old check ran a bare `npm test` as a targeted run, outside the slot another crew held
    symptom: [/error: 'the suite did not run while another crew held the only slot'/, /heavy-031\.check\.ts:149:\d+\)/],
  },
  {
    file: 'tests/heavy-031.check.ts',
    title: 'a job dir whose wrapper has not written anything yet stays alive while its spawner runs, however old the dir',
    // the old jobAlive judged a job dir with no pid.json by its age alone, so a 60 s old dir was dead though its spawner ran
    symptom: [/a live spawner keeps the job alive\s*\n\s*\n\s*false !== true/, /heavy-031\.check\.ts:160:\d+\)/],
  },
]

// The one shim on the old tree. The dccb501f heavy-031.check.ts imports `jobAlive`, which the old bin/factory/heavy.ts declares as a
// module-private `function jobAlive`. Without an export the whole file fails at ESM link time, before any test runs, which proves
// nothing about behaviour. Adding `export` to that declaration changes no behaviour: the old body is what runs.
function shimOldTree(oldPlugin: string): void {
  const p = `${oldPlugin}/bin/factory/heavy.ts`
  const src = readFileSync(p, 'utf8')
  const from = '\nfunction jobAlive(jdir: string): boolean {'
  assert.equal(src.split(from).length, 2, 'the old heavy.ts declares one module-private jobAlive')
  writeFileSync(p, src.replace(from, `\nexport ${from.slice(1)}`))
}

function git(args: string[], env: NodeJS.ProcessEnv = process.env): Buffer {
  const r = spawnSync('git', ['-C', REPO, '-c', 'core.quotepath=off', ...args], { env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${String(r.stderr).slice(0, 400)}`)
  return r.stdout
}

/** The plugin tree of `rev` written to <dir>/plugins/truss, through a private index file. */
function checkout(rev: string, dir: string, scratch: string): void {
  const env = { ...process.env, GIT_INDEX_FILE: `${scratch}/index` }
  git(['read-tree', `${rev}:plugins/truss`], env)
  mkdirSync(`${dir}/plugins/truss`, { recursive: true })
  git(['checkout-index', '-a', '-f', `--prefix=${dir}/plugins/truss/`], env)
}

/** `node --test` of one file narrowed to one title; ok is true only when a TAP line says that title passed. */
function runTitle(cwd: string, file: string, title: string, extraEnv: NodeJS.ProcessEnv): { ok: boolean; status: number | null; text: string } {
  const env = { ...process.env, ...extraEnv }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=120000', '--test-name-pattern', `^${esc(title)}$`, `${cwd}/${file}`], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 240_000 })
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  const ok = text.split('\n').some((l) => new RegExp(`^\\s*ok \\d+ - ${esc(title)}\\s*$`).test(l))
  return { ok: ok && r.status === 0, status: r.status, text }
}

test('the goalCheck pending test and the fixer tests fail against the old code under a test timeout', { timeout: 900_000 }, () => {
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'deferred-032-proof-')))
  try {
    const old = flat(`${scratch}/old`)
    checkout(`${FIX}^`, old, scratch)
    const oldPlugin = `${old}/plugins/truss`
    for (const file of new Set(CASES.map((c) => c.file))) writeFileSync(`${oldPlugin}/${file}`, git(['show', `${FIX}:plugins/truss/${file}`]))
    shimOldTree(oldPlugin)
    const failures: string[] = []
    for (const { file, title, symptom } of CASES) {
      // the new tests, on the old code: the old goal-check hangs until its own limit (3 s here), and the test must fail
      const before = runTitle(oldPlugin, file, title, { TRUSS_GOALCHECK_TIMEOUT_MS: '3000' })
      const failed = before.text.split('\n').some((l) => new RegExp(`^\\s*not ok \\d+ - ${esc(title)}\\s*$`).test(l))
      if (before.ok) failures.push(`passes on the old code (${FIX}^): ${title}`)
      else if (!failed || !symptom.every((s) => s.test(before.text))) failures.push(`fails on the old code, but not at its own assertion (exit ${before.status}): ${title}\n${before.text.slice(-1200)}`)
      // the control: the same title on this checkout passes
      const after = runTitle(REAL_PLUGIN, file, title, {})
      if (!after.ok) failures.push(`does not pass on this checkout (exit ${after.status}): ${title}\n${after.text.slice(-600)}`)
    }
    assert.deepEqual(failures, [], failures.join('\n'))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

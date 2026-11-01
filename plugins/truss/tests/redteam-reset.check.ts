// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0006 section 2 and ADR-0014 Decision 1: the stress test resets its own branch and leaves a clean worktree, and its section
// lives in agents/stress-engineer.md (moved out of qc-engineer.md, which stays read-only). Written before the prompts change.
//
// Run with: node --test tests/redteam-reset.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs. Every read returns ''
// for a missing path, so each test fails on its own assertion. Every failure says "producer missing".

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...parts: string[]): string => {
  try {
    return readFileSync(join(PLUGIN, ...parts), 'utf8').replace(/\r/g, '')
  } catch {
    return ''
  }
}
const QC = read('agents', 'qc-engineer.md')
const STRESS = read('agents', 'stress-engineer.md')
const FOREMAN = read('agents', 'foreman.md')

const RED_START = 'Stress test:'
const RESET = 'git reset --hard <sha>'

// the stress test section of stress-engineer.md: from its first `Stress test:` line to the next `## ` heading ('' when the start is missing)
const stressTest = (): string => {
  const i = STRESS.indexOf(RED_START)
  if (i < 0) return ''
  const rest = STRESS.slice(i)
  const j = rest.search(/\n## /)
  return j < 0 ? rest : rest.slice(0, j)
}
const present = (needle: string) =>
  assert.ok(stressTest().includes(needle), `producer missing: stress-engineer.md stress test section does not carry ${JSON.stringify(needle)}`)

test('stress-engineer.md stress test section resets to the sha at least twice (start and end)', () => {
  assert.ok(stressTest().length > 0, 'producer missing: stress-engineer.md has no stress test section')
  const n = stressTest().split(RESET).length - 1
  assert.ok(n >= 2, `producer missing: stress-engineer.md stress test section carries ${JSON.stringify(RESET)} ${n} time(s), want at least 2`)
})

for (const lit of [
  'git clean -fd',
  'git status --porcelain --untracked-files=all',
  'even when the worktrees hook tells you to commit',
  'discard',
  'temp dir',
]) {
  test(`stress-engineer.md stress test section carries ${JSON.stringify(lit)}`, () => present(lit))
}

const GIT_DIR = 'git rev-parse --path-format=absolute --git-dir'
for (const lit of [GIT_DIR, 'git rev-parse --path-format=absolute --git-common-dir', 'git branch --show-current', 'worktree-agent-', 'worktree-wf_']) {
  test(`stress-engineer.md stress test section carries ${JSON.stringify(lit)}`, () => present(lit))
}

test('stress-engineer.md stress test section checks the worktree before the first reset', () => {
  const s = stressTest()
  const reset = s.indexOf(RESET)
  for (const lit of [GIT_DIR, 'git branch --show-current']) {
    const at = s.indexOf(lit)
    assert.ok(at >= 0, `producer missing: stress-engineer.md stress test section has no ${JSON.stringify(lit)}`)
    assert.ok(reset >= 0 && at < reset, `producer missing: stress-engineer.md ${JSON.stringify(lit)} does not come before the first ${JSON.stringify(RESET)}`)
  }
})

test('stress-engineer.md no longer says "git checkout --detach" anywhere', () => {
  assert.ok(STRESS.length > 0, 'producer missing: stress-engineer.md not readable')
  assert.ok(!STRESS.includes('git checkout --detach'), 'producer missing: stress-engineer.md still carries "git checkout --detach"')
})

test('qc-engineer.md no longer says "git checkout --detach" anywhere', () => {
  assert.ok(QC.length > 0, 'qc-engineer.md not readable')
  assert.ok(!QC.includes('git checkout --detach'), 'qc-engineer.md still carries "git checkout --detach"')
})

test('qc-engineer.md no longer carries "git reset --hard <sha>" (the stress test section moved)', () => {
  assert.ok(QC.length > 0, 'qc-engineer.md not readable')
  assert.ok(!QC.includes(RESET), `producer missing: qc-engineer.md still carries ${JSON.stringify(RESET)}`)
})

test('stress-engineer.md times with "%s%N" and never "/usr/bin/time"', () => {
  assert.ok(STRESS.includes('%s%N'), 'producer missing: stress-engineer.md does not carry "%s%N"')
  assert.ok(!STRESS.includes('/usr/bin/time'), 'producer missing: stress-engineer.md carries "/usr/bin/time" (or is unreadable)')
  assert.ok(STRESS.length > 0, 'producer missing: stress-engineer.md not readable')
})

const foremanBullet = (): string => FOREMAN.split('\n').find((l: string) => l.startsWith('- **Stress test, when the brief says yes.**')) ?? ''

test('foreman.md stress test bullet does not say "checks out"', () => {
  assert.ok(foremanBullet().length > 0, 'producer missing: foreman.md has no stress test bullet')
  assert.ok(!foremanBullet().includes('checks out'), 'producer missing: foreman.md stress test bullet still says "checks out"')
})

test('foreman.md stress test bullet carries "git reset --hard <sha>"', () => {
  assert.ok(foremanBullet().includes(RESET), `producer missing: foreman.md stress test bullet does not carry ${JSON.stringify(RESET)}`)
})

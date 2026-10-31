// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0006 section 2: the stress test resets its own branch and leaves a clean worktree. Written before the prompts change.
//
// Run with: node --test tests/stress-reset.check.ts
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
const FOREMAN = read('agents', 'foreman.md')

const RED_START = 'When your brief opens with the line `Stress test:`'
const RESET = 'git reset --hard <sha>'

// the stress test section: from its first line to the next `## ` heading ('' when the start is missing)
const stressTest = (): string => {
  const i = QC.indexOf(RED_START)
  if (i < 0) return ''
  const rest = QC.slice(i)
  const j = rest.search(/\n## /)
  return j < 0 ? rest : rest.slice(0, j)
}
const present = (needle: string) =>
  assert.ok(stressTest().includes(needle), `producer missing: qc-engineer.md stress test section does not carry ${JSON.stringify(needle)}`)

test('qc-engineer.md stress test section resets to the sha at least twice (start and end)', () => {
  assert.ok(stressTest().length > 0, 'producer missing: qc-engineer.md has no stress test section')
  const n = stressTest().split(RESET).length - 1
  assert.ok(n >= 2, `producer missing: qc-engineer.md stress test section carries ${JSON.stringify(RESET)} ${n} time(s), want at least 2`)
})

for (const lit of [
  'git clean -fd',
  'git status --porcelain --untracked-files=all',
  'even when the worktrees hook tells you to commit',
  'discard',
  'temp dir',
]) {
  test(`qc-engineer.md stress test section carries ${JSON.stringify(lit)}`, () => present(lit))
}

const GIT_DIR = 'git rev-parse --path-format=absolute --git-dir'
for (const lit of [GIT_DIR, 'git rev-parse --path-format=absolute --git-common-dir', 'git branch --show-current', 'worktree-agent-', 'worktree-wf_']) {
  test(`qc-engineer.md stress test section carries ${JSON.stringify(lit)}`, () => present(lit))
}

test('qc-engineer.md stress test section checks the worktree before the first reset', () => {
  const s = stressTest()
  const reset = s.indexOf(RESET)
  for (const lit of [GIT_DIR, 'git branch --show-current']) {
    const at = s.indexOf(lit)
    assert.ok(at >= 0, `producer missing: qc-engineer.md stress test section has no ${JSON.stringify(lit)}`)
    assert.ok(reset >= 0 && at < reset, `producer missing: ${JSON.stringify(lit)} does not come before the first ${JSON.stringify(RESET)}`)
  }
})

test('qc-engineer.md no longer says "git checkout --detach" anywhere', () => {
  assert.ok(QC.length > 0, 'producer missing: qc-engineer.md not readable')
  assert.ok(!QC.includes('git checkout --detach'), 'producer missing: qc-engineer.md still carries "git checkout --detach"')
})

const foremanBullet = (): string => FOREMAN.split('\n').find((l: string) => l.startsWith('- **Stress test, when the brief says yes.**')) ?? ''

test('foreman.md stress test bullet does not say "checks out"', () => {
  assert.ok(foremanBullet().length > 0, 'producer missing: foreman.md has no stress test bullet')
  assert.ok(!foremanBullet().includes('checks out'), 'producer missing: foreman.md stress test bullet still says "checks out"')
})

test('foreman.md stress test bullet carries "git reset --hard <sha>"', () => {
  assert.ok(foremanBullet().includes(RESET), `producer missing: foreman.md stress test bullet does not carry ${JSON.stringify(RESET)}`)
})

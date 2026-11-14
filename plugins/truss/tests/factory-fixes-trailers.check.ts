// @ts-nocheck
// Commit trailers: the member brief says where Truss-Crew / Truss-Role go, and the merge check stays strict.
// Run with: node --test tests/factory-fixes-trailers.check.ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { unparsedTrailers } from '../bin/factory.ts'

const stageSrc = readFileSync(path.join(import.meta.dirname, '..', 'workflows', 'stage.js'), 'utf8')

test('the member brief tells members to keep Truss trailers in the same final paragraph as Co-Authored-By, with an example', () => {
  assert.match(stageSrc, /same final paragraph as any Co-Authored-By or Claude-Session lines/)
  assert.match(stageSrc, /with no blank line between any of them/)
  const i = stageSrc.indexOf("'Co-Authored-By: Name <name@example.com>'")
  assert.ok(i > 0, 'literal example is in the brief')
  const ex = stageSrc.slice(stageSrc.lastIndexOf("'Subject line'", i), i)
  assert.match(ex, /`Truss-Crew: \$\{crew\.slug\}`,\s*`Truss-Role: \$\{TRAILER_ROLE\[role\]\}`,\s*$/, 'trailers directly above Co-Authored-By')
})

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

test('unparsedTrailers flags a blank line before Co-Authored-By and accepts the single-paragraph layout', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'truss-trailers-'))
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(path.join(dir, 'a'), '0')
  git(dir, 'add', 'a')
  git(dir, 'commit', '-q', '-m', 'base')
  git(dir, 'checkout', '-q', '-b', 'member')
  const commit = (n, msg) => {
    writeFileSync(path.join(dir, 'a'), n)
    git(dir, 'commit', '-q', '-a', '-m', msg)
    return git(dir, 'rev-parse', 'HEAD')
  }
  const bad = commit('1', 'bad\n\nTruss-Crew: x\nTruss-Role: builder\n\nCo-Authored-By: A <a@example.com>\nClaude-Session: s')
  const good = commit('2', 'good\n\nBody.\n\nTruss-Crew: x\nTruss-Role: builder\nCo-Authored-By: A <a@example.com>\nClaude-Session: s')
  git(dir, 'checkout', '-q', 'main')
  const out = unparsedTrailers(dir, 'main', 'member')
  assert.deepEqual(out, [`${bad} bad`])
  assert.ok(!out.some((l) => l.startsWith(good)))
})

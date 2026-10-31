// @ts-nocheck
// truss ADR-0014 Decision 2 (P-8): the WIRING of the main-thread Edit/Write gate in hooks/register.ts. The verdict itself
// is pinned by tests/main-edit-gate-contract.check.ts; this file pins what feeds it: `worktreeRootsOf`, the handler's
// shape, and a round trip with this repo's own layout. Runs under plain node (no `claude-code/testing`, which is
// harness-only). register.ts is loaded dynamically inside each test, so a missing export fails one assertion, not the load.
// (Importing codeOnly from hooks-load.check.ts also registers that file's own tests in this run.)
//
// Run with: node --test tests/main-edit-gate.check.ts

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { codeOnly } from './hooks-load.check.ts'

const REGISTER = new URL('../hooks/register.ts', import.meta.url)
const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

async function exportOf(name: string): Promise<(...a: unknown[]) => any> {
  let mod: Record<string, unknown>
  try {
    mod = await import('../hooks/register.ts')
  } catch (err) {
    assert.fail(`producer missing: hooks ${name} (register.ts did not load: ${(err as Error).message})`)
  }
  assert.equal(typeof mod[name], 'function', `producer missing: hooks ${name} is not exported`)
  return mod[name] as (...a: unknown[]) => any
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

test('worktreeRootsOf returns every worktree of a real repo, main checkout first', async () => {
  const worktreeRootsOf = await exportOf('worktreeRootsOf')
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gate-wt-')))
  try {
    const main = join(tmp, 'main')
    const second = join(tmp, 'second')
    git(tmp, 'init', '-q', main)
    writeFileSync(join(main, 'a.txt'), 'a\n')
    git(main, 'add', 'a.txt')
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'one')
    git(main, 'worktree', 'add', '-q', '-b', 'other', second)
    const out = git(main, 'worktree', 'list', '--porcelain')
    assert.deepEqual(worktreeRootsOf(out), [main, second])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('worktreeRootsOf reads bare, detached and locked entries and CRLF line ends', async () => {
  const worktreeRootsOf = await exportOf('worktreeRootsOf')
  const text = [
    'worktree /srv/repo.git',
    'bare',
    '',
    'worktree /srv/wt/one/',
    'HEAD 0123456789abcdef0123456789abcdef01234567',
    'detached',
    '',
    'worktree /srv/wt/two',
    'HEAD 0123456789abcdef0123456789abcdef01234567',
    'branch refs/heads/two',
    'locked reason text',
    '',
  ].join('\r\n')
  assert.deepEqual(worktreeRootsOf(text), ['/srv/repo.git', '/srv/wt/one', '/srv/wt/two'])
  assert.deepEqual(worktreeRootsOf(''), [])
})

// the handler: locate the on('tool.call', { tool: [...] }) whose list is exactly the four editing tools
function gateHandler(): { code: string; raw: string; rawSrc: string } {
  const rawSrc = readFileSync(REGISTER, 'utf8')
  const code = codeOnly(rawSrc)
  const re = /on\(\s*'tool\.call'\s*,\s*\{\s*tool:\s*\[([^\]]*)\]/g
  const want = ['Edit', 'MultiEdit', 'NotebookEdit', 'Write']
  for (let m; (m = re.exec(rawSrc)); ) {
    const list = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
    if (list.length === want.length && list.every((v, i) => v === want[i])) {
      const end = code.indexOf('.catch(failOpen)', m.index)
      assert.ok(end > m.index, 'the gate handler must end with .catch(failOpen)')
      const stop = end + '.catch(failOpen)'.length
      return { code: code.slice(m.index, stop), raw: rawSrc.slice(m.index, stop), rawSrc }
    }
  }
  assert.fail("no on('tool.call', { tool: [...] }) handler lists exactly Edit, Write, MultiEdit and NotebookEdit")
}

test('static wiring: one tool.call handler for the four editing tools, calling the verdict with its inputs', () => {
  const { code, raw } = gateHandler()
  for (const needle of ['mainEditVerdict(', 'refuse(', 'planPath(', 'worktreeRootsOf(', 'notebook_path', 'agentId', 'next(']) {
    assert.ok(code.includes(needle), `gate handler must use ${needle}`)
  }
  assert.ok(raw.includes('.claude/truss.json'), 'gate handler must read .claude/truss.json')
  assert.ok(raw.includes('architecture'), "gate handler must read the config's architecture key")
})

test('static wiring: the decision-time Write/Edit handler is still present', () => {
  const { rawSrc } = gateHandler()
  const re = /on\(\s*'tool\.call'\s*,\s*\{\s*tool:\s*\[([^\]]*)\]/g
  let found = false
  for (let m; (m = re.exec(rawSrc)); ) {
    const list = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
    if (list.includes('Write') && list.includes('Edit') && !list.includes('NotebookEdit')) found = true
  }
  assert.ok(found, 'the existing decision-time Write/Edit tool.call handler must remain')
})

test('round trip: this repo layout refuses hooks/register.ts and allows docs/requirements.md during a run', async () => {
  const worktreeRootsOf = await exportOf('worktreeRootsOf')
  const mainEditVerdict = await exportOf('mainEditVerdict')
  const roots = worktreeRootsOf(git(REPO_ROOT, 'worktree', 'list', '--porcelain'))
  assert.ok(roots.length >= 1, 'this checkout lists at least one worktree')
  const repoRoot = roots[0]
  const cfg = JSON.parse(readFileSync(new URL('../.claude/truss.json', import.meta.url), 'utf8'))
  const planText = JSON.stringify({ version: 1, approval: 'auto', crews: [{ name: 'c1', status: 'running' }] })
  const ctx = { repoRoot, worktreeRoots: roots, trussDir: `${repoRoot}/.git/truss/sess`, planText, architecture: cfg.architecture }
  const refused = mainEditVerdict({ tool: 'Edit', filePath: `${repoRoot}/hooks/register.ts` }, ctx)
  assert.ok(refused && /^\[truss\] Refused:/.test(refused.deny), 'hooks/register.ts must be refused')
  assert.equal(mainEditVerdict({ tool: 'Write', filePath: `${repoRoot}/docs/requirements.md` }, ctx), undefined)
})

// Builds a git repo with a knowledge layout for the consolidation tests (consolidation-032.check.ts). Each case is a flag, so
// a test builds a fixture holding only the one case it tests, and the first title builds all four in one repo.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type Cases = { dup?: boolean; contra?: boolean; unsupported?: boolean; linecite?: boolean }
export type Fixture = { repo: string; dir: string; cleanup: () => void }

export const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

const put = (root: string, rel: string, text: string): void => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), text)
}

export function buildFixture(cases: Cases): Fixture {
  const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'consolidation-repo-')))
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'consolidation-dir-')))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@example.com')
  git(repo, 'config', 'user.name', 'T')
  git(repo, 'config', 'commit.gpgsign', 'false')
  git(repo, 'config', 'maintenance.auto', 'false')
  git(repo, 'config', 'gc.auto', '0')
  put(repo, '.claude/truss.json', JSON.stringify({ featureMap: 'docs/features.md', knowledgeDir: 'docs/knowledge', architecture: 'docs/architecture.md' }, null, 2) + '\n')
  put(repo, 'src/ok.ts', 'export function okFn() {\n  return 1\n}\n')

  let features = '# Features\n\n## Ok capability\n\nEntry points: `src/ok.ts`.\n\nThis one is healthy.\n'
  if (cases.dup) {
    put(repo, 'src/login.ts', 'export function login() {\n  return true\n}\n')
    put(repo, 'src/login-extra.ts', 'export function loginExtra() {\n  return true\n}\n')
    features += '\n## Login\n\nEntry points: `src/login.ts`.\n\nLogin checks the password.\n'
    features += '\n## login\n\nEntry points: `src/login-extra.ts`.\n\nLogin also checks the second factor.\n'
  }
  if (cases.unsupported) features += '\n## Gone feature\n\nEntry points: `src/gone.ts`.\n\nThis feature was removed from the code.\n'
  put(repo, 'docs/features.md', features)

  let store = '# Store\n\n## Locks\n\nThe `src/ok.ts` `okFn` returns one.\n'
  if (cases.contra) {
    put(repo, 'src/lock.ts', 'export function acquire() {\n  return 1\n}\n')
    store += '\nThe `src/lock.ts` `withLock` takes the lock before it writes.\n'
  }
  put(repo, 'docs/knowledge/store.md', store)

  let arch = '# Architecture\n\n## Modules\n\nThe store is the only writer.\n'
  if (cases.linecite) {
    put(repo, 'src/util.ts', '// util\nexport function helper(a: number) {\n  return a + 1\n}\n')
    arch += '\nThe helper is described at `src/util.ts:3`.\n'
  }
  put(repo, 'docs/architecture.md', arch)

  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  return { repo, dir, cleanup: () => { rmSync(repo, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) } }
}

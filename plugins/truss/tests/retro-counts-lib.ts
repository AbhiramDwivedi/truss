// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// Shared helpers for the retro counts tests (retro-counts*.check.ts): run `node retro/cli.ts counts <dir>` in a
// child process, write synthetic session dirs into temp dirs (never into fixtures/, P8), and build event lines.
// Not a test file: only the *.check.ts files import it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { counts } from '../retro/counts.ts'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const PLUGIN = join(HERE, '..')
export const CLI = join(PLUGIN, 'retro', 'cli.ts')
export const FIXTURES = join(HERE, 'fixtures')
export const NR = 'not recorded'
export const TOP_KEYS = ['leftovers', 'leftoverDetails', 'retro', 'dir', 'split', 'runs', 'qcFiles', 'plan', 'eventsSkipped', 'eventsOutsideRuns'].sort()

// `git -C repo ...` with a fixed identity and no signing; returns stdout and throws on failure
export const repoGit = (repo: string, ...args: string[]): string => {
  const r = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`)
  return r.stdout
}

const tmps: string[] = []
export const mktmp = (prefix = 'retro-counts-'): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmps.push(d)
  return d
}
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true })
})

// run the counts for a dir; text output decoded as UTF-8
// in-process: calls counts() the way cli.ts main does (same {code, out, err} result), with cwd and env swapped in
// for the call when given, so no test pays a node start-up
export const runCounts = (dir: string, opts: { cwd?: string; env?: Record<string, string> } = {}) => {
  const cwd0 = process.cwd()
  const env0 = process.env
  try {
    if (opts.cwd) process.chdir(opts.cwd)
    if (opts.env) process.env = { ...opts.env }
    const r = counts([dir])
    return { code: r.code, stdout: r.out, stderr: r.err ?? '' }
  } finally {
    process.env = env0
    process.chdir(cwd0)
  }
}

// the real process: `node cli.ts counts <args>`, for the few tests that check the CLI itself
export const runCli = (args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, 'counts', ...args], { timeout: 120000, maxBuffer: 1 << 28 })
  return { code: r.status, stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8') }
}

// the parsed JSON; fails when the exit code is not 0 or the stdout is not strict JSON (JSON.parse rejects NaN)
export const retro = (dir: string, opts = {}) => {
  const r = runCounts(dir, opts)
  assert.equal(r.code, 0, `exit ${r.code}, stderr: ${r.stderr.slice(-300)}`)
  return JSON.parse(r.stdout)
}

// every file under root, relative path to bytes
export const snapshot = (root: string): Record<string, string> => {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[relative(root, p)] = readFileSync(p).toString('latin1')
    }
  }
  walk(root)
  return out
}

// write a file in a dir: strings as UTF-8 without newline translation, buffers as they are
export const write = (dir: string, name: string, data: string | Buffer): void => {
  mkdirSync(dirname(join(dir, name)), { recursive: true })
  writeFileSync(join(dir, name), data)
}

// run git in cwd with a fixed author and the given date; returns stdout and throws on failure
export const git = (cwd: string, date: string, ...args: string[]): string => {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 'author@example.invalid',
    GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 'author@example.invalid',
    GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
  }
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

// an event line the way the hooks write it
export const ev = (ts: string, event: string, kw: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, ts, event, crew: 'c', agent: 'c', ...kw })

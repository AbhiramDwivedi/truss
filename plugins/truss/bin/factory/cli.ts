// CLI plumbing every factory command module shares: the plugin and CLI paths, flag parsing, git, repo and dir flags, the crew
// worktree. Split from bin/factory/shared.ts (0.32.0 item 8). Never imports factory.ts, whose top-level await would make an
// import cycle.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { flat, need, str, usage } from '../core.ts'
import type { Flags } from '../core.ts'

export const PLUGIN = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))).replace(/\\/g, '/')
// The CLI file itself, which heavy and gates run again as a child process.
export const FACTORY = fileURLToPath(new URL('../factory.ts', import.meta.url))

// Flags as `--key value` or `--key=value` (the `=` form is the safe one for a value that starts with `--`); a flag with no value
// is true; a repeated flag becomes a list.
export function parseFlags(argv: string[]): Flags {
  const flags: Flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw usage(`unexpected argument: ${a}`)
    const eq = a.indexOf('=')
    const key = eq < 0 ? a.slice(2) : a.slice(2, eq)
    const next = argv[i + 1]
    const value: string | boolean = eq >= 0 ? a.slice(eq + 1) : next === undefined || next.startsWith('--') ? true : (i++, next)
    const old = flags[key]
    flags[key] = old === undefined ? value : [...(Array.isArray(old) ? old : [String(old)]), String(value)]
  }
  return flags
}
// Runs git in `cwd` and returns status, trimmed stdout and stderr.
export function run(cwd: string, args: string[]): { status: number; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.error) throw usage(`git failed to run: ${r.error.message}`)
  return { status: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}
export function gitOrFail(cwd: string, args: string[]): string {
  const r = run(cwd, args)
  if (r.status !== 0) throw usage(`git ${args.join(' ')} failed: ${r.err || r.out}`)
  return r.out
}

export function repoOf(f: Flags): string {
  const given = str(f, 'repo')
  if (given !== undefined && given !== '') return flat(given)
  const r = run(process.cwd(), ['rev-parse', '--show-toplevel'])
  if (r.status !== 0) throw usage('no --repo and the cwd is not in a git repository')
  return flat(r.out)
}
// ADR-0027 F-67 item 2: every command but start refuses a relative --dir, since a relative one resolves against
// whatever cwd ran it. start (and start --resume) resolve it themselves through startDirOf, as ADR-0019 item 18 left them.
export const startDirOf = (f: Flags): string => flat(need(f, 'dir'))
export const dirOf = (f: Flags): string => {
  const d = need(f, 'dir')
  if (!path.isAbsolute(d)) throw usage(`--dir must be an absolute path, got ${d}`)
  return flat(d)
}

export const intOr = (v: unknown, dflt: number, min: number): number => (Number.isInteger(v) && (v as number) >= min ? (v as number) : dflt)

// The crew worktree path <repo>/.claude/worktrees/truss-<slug>.
export function crewWorktree(repo: string, slug: string): string {
  return `${repo}/.claude/worktrees/truss-${slug}`
}
// `git merge-base <target> HEAD` in the worktree: the target head last merged into the crew branch.
export function baseOf(worktree: string, target: string): string {
  return gitOrFail(worktree, ['merge-base', target, 'HEAD'])
}

// The architecture doc as an absolute path (the key `architecture` of truss.json, repo-relative, default docs/architecture.md).
export const archPath = (repo: string, rel: unknown): string => path.isAbsolute(String(rel)) ? flat(String(rel)) : `${repo}/${typeof rel === 'string' && rel !== '' ? rel : 'docs/architecture.md'}`

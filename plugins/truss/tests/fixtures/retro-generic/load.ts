// Materialises the scrubbed wave-4 fixture: a git repo replayed from wave4-git.json, and the run bundle written to
// <repo>/.git/truss/<fake sid>/. `loadWave4()` makes its own mkdtemp dir. Run directly as
//   node plugins/truss/tests/fixtures/retro-generic/load.ts <out dir>
// to build the same thing in <out dir> and print the truss dir. Erasable TypeScript, Node built-ins only.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const WAVE4_SID = 'sid-wave4'

type GitFile = { path: string; added: number; deleted: number }
type GitCommit = { subject: string; ts: string; trailers: string[]; files: GitFile[] }
export type Wave4Git = { commits: GitCommit[]; sizes: Record<string, number> }
export type Wave4Run = { files: Record<string, string>; mtimes: Record<string, number> }

export const readWave4Git = (): Wave4Git => JSON.parse(readFileSync(path.join(HERE, 'wave4-git.json'), 'utf8'))
export const readWave4Run = (): Wave4Run => JSON.parse(readFileSync(path.join(HERE, 'wave4-run.json'), 'utf8'))

const git = (repo: string, args: string[], input?: string): string => {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', '-C', repo, ...args], { windowsHide: true, encoding: 'utf8', input })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

// the file text at `n` lines; the first `touched` lines carry the commit index, so a commit that adds as many lines
// as it deletes still changes the file
const body = (p: string, n: number, touched: number, idx: number): string => {
  const lines: string[] = []
  for (let i = 0; i < n; i++) lines.push(i < touched ? `c${idx} ${i}` : `l ${i}`)
  return n === 0 ? '' : `${lines.join('\n')}\n`
}

const replay = (repo: string, data: Wave4Git): void => {
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'maintenance.auto', 'false'])
  git(repo, ['config', 'gc.auto', '0'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  git(repo, ['config', 'user.name', 'Fixture'])
  git(repo, ['config', 'user.email', 'fixture@example.invalid'])
  // each path starts at its end-of-window size less what the window added net
  const cur = new Map<string, number>()
  const net = new Map<string, number>()
  for (const c of data.commits) for (const f of c.files) net.set(f.path, (net.get(f.path) ?? 0) + f.added - f.deleted)
  for (const [p, n] of net) cur.set(p, Math.max(0, (data.sizes[p] ?? 0) - n))
  for (const [p, n] of cur) {
    if (n === 0) continue
    mkdirSync(path.dirname(path.join(repo, p)), { recursive: true })
    writeFileSync(path.join(repo, p), body(p, n, 0, -1))
  }
  const last = new Map<string, number>()
  data.commits.forEach((c, i) => c.files.forEach((f) => last.set(f.path, i)))
  data.commits.forEach((c, idx) => {
    for (const f of c.files) {
      const n = Math.max(0, (cur.get(f.path) ?? 0) + f.added - f.deleted)
      cur.set(f.path, n)
      const file = path.join(repo, f.path)
      if (n === 0 && !(f.path in data.sizes) && last.get(f.path) === idx) {
        rmSync(file, { force: true })
        continue
      }
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, body(f.path, n, Math.min(n, Math.max(f.added, f.deleted, 1)), idx))
    }
    git(repo, ['add', '-A', '--', '.'])
    const msg = `${c.subject}\n\n${c.trailers.join('\n')}\n`
    const env = { ...process.env, GIT_AUTHOR_DATE: c.ts, GIT_COMMITTER_DATE: c.ts }
    const r = spawnSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '--no-verify', '-F', '-'], { windowsHide: true, encoding: 'utf8', input: msg, env })
    if (r.status !== 0) throw new Error(`commit ${idx} failed: ${r.stderr}`)
  })
}

/** Builds the fixture into `root` (an existing dir) and returns the repo and the truss dir. */
export const materialise = (root: string): { repo: string; dir: string } => {
  const repo = root
  replay(repo, readWave4Git())
  const dir = path.join(repo, '.git', 'truss', WAVE4_SID)
  const run = readWave4Run()
  for (const [rel, text] of Object.entries(run.files)) {
    const p = path.join(dir, rel)
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, text)
    const ms = run.mtimes[rel]
    if (ms !== undefined) utimesSync(p, ms / 1000, ms / 1000)
  }
  return { repo, dir }
}

export function loadWave4(): { repo: string; dir: string; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wave4-')))
  const { repo, dir } = materialise(root)
  return { repo, dir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2]
  if (!out) {
    process.stderr.write('usage: node load.ts <out dir>\n')
    process.exit(2)
  }
  mkdirSync(out, { recursive: true })
  process.stdout.write(`${materialise(realpathSync(out)).dir}\n`)
}

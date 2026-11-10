// truss contract-025 section 2 (ADR-0037): the one place that locks files, writes shared state and finds transcripts, plus the
// helpers every bin module shares. Node built-ins and relative paths only; no module imports factory.ts, which has a top-level await.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { homedir, hostname } from 'node:os'
import path from 'node:path'

// ==== core (moved unchanged from factory.ts) ====

export class CliError extends Error {
  code: number
  body: Record<string, unknown>
  constructor(code: number, body: Record<string, unknown>) {
    super(typeof body.error === 'string' ? body.error : JSON.stringify(body))
    this.code = code
    this.body = body
  }
}
export const usage = (message: string): CliError => new CliError(2, { error: message })
export const refuse = (body: Record<string, unknown>): CliError => new CliError(1, body)

export type Flags = Record<string, string | boolean | string[]>
export type Obj = Record<string, any>

export const flat = (p: string): string => String(p).replace(/\\/g, '/')

export const str = (f: Flags, key: string): string | undefined => {
  const v = f[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw usage(`--${key} needs a value`)
  return v
}
export const need = (f: Flags, key: string): string => {
  const v = str(f, key)
  if (v === undefined || v === '') throw usage(`missing --${key}`)
  return v
}
export const listOf = (f: Flags, key: string): string[] => {
  const v = f[key]
  if (v === undefined) return []
  if (v === true) throw usage(`--${key} needs a value`)
  return Array.isArray(v) ? v : [String(v)]
}

export const readText = (p: string): string => {
  try {
    return nodeFs.readFileSync(p, 'utf8')
  } catch (e) {
    throw usage(`cannot read ${flat(p)}: ${(e as Error).message}`)
  }
}
export const readJson = (p: string): any => {
  const text = readText(p)
  try {
    return JSON.parse(text.startsWith('﻿') ? text.slice(1) : text)
  } catch {
    throw usage(`${flat(p)} is not JSON`)
  }
}
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

// A Workflow label as {slug, role, n}: strip a trailing -<n> (n >= 2) first, the last segment is the role, the rest the slug. Undefined when it has no role segment.
export function parseLabel(label: string): { slug: string; role: string; n: number } | undefined {
  if (typeof label !== 'string') return undefined
  let rest = label
  let n = 1
  const m = /-(\d+)$/.exec(rest)
  if (m) {
    n = Number(m[1])
    if (n < 2) return undefined
    rest = rest.slice(0, m.index)
  }
  const cut = rest.lastIndexOf('-')
  if (cut <= 0 || cut === rest.length - 1) return undefined
  return { slug: rest.slice(0, cut), role: rest.slice(cut + 1), n }
}

// The repo's .claude/truss.json as an object ({} when absent).
export function configOf(repo: string): Obj {
  const p = `${repo}/.claude/truss.json`
  if (!nodeFs.existsSync(p)) return {}
  const v = readJson(p)
  return isObj(v) ? v : {}
}

// A path key of truss.json (featureMap, adrDir): a non-empty string that is relative and stays inside the repo (no `..` segment, no
// drive letter), as a clean repo-relative path with no leading ./ or trailing /; undefined for anything else. A Windows backslash
// is a separator: it is turned into `/` first, then the path is checked.
export function repoPathOf(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.trim() === '' || /[\r\n]/.test(v)) return undefined
  const p = v.trim().replace(/\\/g, '/')
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some((s) => s === '..')) return undefined
  const clean = p.replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  return clean === '' ? undefined : clean
}

// The package name of a bare import specifier (`@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`).
export const packageName = (spec: string): string => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/')
// True when the package.json nearest to `from` (walking up) declares `pkg` in any dependency list.
export function declares(from: string, pkg: string): boolean {
  for (let d = path.dirname(from); ; d = path.dirname(d)) {
    const p = `${d}/package.json`
    if (nodeFs.existsSync(p)) {
      try {
        const j = JSON.parse(nodeFs.readFileSync(p, 'utf8'))
        return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some((k) => isObj(j?.[k]) && Object.hasOwn(j[k], pkg))
      } catch {
        return false
      }
    }
    if (path.dirname(d) === d) return false
  }
}

// ==== git roots ====

// Runs git in `cwd` and returns status, trimmed stdout and stderr. Child process, no shell.
export function git(cwd: string, args: string[]): { status: number; out: string; err: string } {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', windowsHide: true })
  if (r.error) throw usage(`git failed to run: ${r.error.message}`)
  return { status: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}
// <common>: the repo's git common dir as an absolute, forward-slash path. Outside git it is a usage error.
export function commonDir(repo: string): string {
  const r = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (r.status !== 0 || r.out === '') throw usage(`needs a git repo: ${flat(repo)}`)
  return flat(r.out)
}
// S: where state shared by every session of the repo lives.
export const sharedDir = (repo: string): string => `${commonDir(repo)}/truss/shared`

// ==== fs seam ====

// The node:fs sync functions a caller may replace (a test injects a failing one); an omitted one is the real one.
export type FsLike = Partial<typeof nodeFs>
const fn = <K extends keyof typeof nodeFs>(fs: FsLike | undefined, name: K): (typeof nodeFs)[K] => (fs?.[name] ?? nodeFs[name]) as (typeof nodeFs)[K]

// Waits ms without a busy loop or a shell: Atomics.wait on a private buffer.
const sleepSync = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const safeName = (name: string, what: string): string => {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') throw usage(`${what} must hold only letters, digits, . _ and -: ${name}`)
  return name
}

// ==== locks ====

export class StoreBusy extends CliError {
  constructor(name: string) {
    super(2, { error: `store busy: ${name}` })
  }
}

const STALE_AGE_MS = 120_000 // a lock older than this is stale whoever owns it
const OWNERLESS_MS = 10_000 // a lock dir with no readable owner.json this old was abandoned between mkdir and the owner write

export type LockOpts = { waitMs?: number; platform?: NodeJS.Platform; fs?: FsLike; host?: string; now?: () => number }

// Copied from resources/index.ts (not imported). Dead means no such process; EPERM means it exists.
function pidDead(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return false
  } catch (e: any) {
    return e.code === 'ESRCH'
  }
}

function readOwner(lock: string, fs?: FsLike): any {
  try {
    return JSON.parse(fn(fs, 'readFileSync')(`${lock}/owner.json`, 'utf8') as string)
  } catch {
    return null
  }
}

// Copied from resources/index.ts takeOver: renames a stale lock to a unique name, checks it is the stale one, renames back if not.
// On win32 a rename can fail for a moment while a scanner holds a handle, so it is retried there.
function takeOver(lock: string, seenToken: string | null, platform: NodeJS.Platform, fs?: FsLike): boolean {
  const moved = `${lock}.stale-${process.pid}-${randomUUID()}`
  const rename = fn(fs, 'renameSync')
  for (let attempt = 0; ; attempt++) {
    try {
      rename(lock, moved)
      break
    } catch (e: any) {
      if (platform === 'win32' && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') && attempt < 5) {
        sleepSync(20)
        continue
      }
      return false
    }
  }
  const o = readOwner(moved, fs)
  const tok = o && typeof o.token === 'string' ? o.token : null
  if (tok !== seenToken) {
    try {
      rename(moved, lock)
    } catch {
      fn(fs, 'rmSync')(moved, { recursive: true, force: true })
    }
    return false
  }
  fn(fs, 'rmSync')(moved, { recursive: true, force: true })
  return true
}

// Runs f holding the lock <dir>/locks/<name>.lock and returns its result. Waits up to waitMs, retrying every 25 ms, then throws StoreBusy.
// Never take a second lock inside f.
export function withLock<T>(dir: string, name: string, f: () => T, opts: LockOpts = {}): T {
  safeName(name, 'lock name')
  const { waitMs = 5000, platform = process.platform, fs, host = hostname(), now = Date.now } = opts
  const mkdir = fn(fs, 'mkdirSync')
  const locks = `${flat(dir)}/locks`
  const lock = `${locks}/${name}.lock`
  mkdir(locks, { recursive: true })
  const deadline = Date.now() + waitMs
  let token = ''
  for (;;) {
    try {
      mkdir(lock)
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e
      const o = readOwner(lock, fs)
      let stale = false
      if (o) stale = (o.host === host && pidDead(o.pid)) || (typeof o.since === 'number' && now() - o.since > STALE_AGE_MS)
      else {
        try {
          stale = Date.now() - fn(fs, 'statSync')(lock).mtimeMs > OWNERLESS_MS
        } catch {
          stale = false
        }
      }
      if (stale && takeOver(lock, o && typeof o.token === 'string' ? o.token : null, platform, fs)) continue
      if (Date.now() >= deadline) throw new StoreBusy(name)
      sleepSync(25)
      continue
    }
    token = randomUUID()
    try {
      fn(fs, 'writeFileSync')(`${lock}/owner.json`, JSON.stringify({ pid: process.pid, host, token, since: now() }))
      break
    } catch (e: any) {
      // the lock was taken over from under a slow mkdir-then-write: start again; any other failure is real
      if (e.code === 'ENOENT') continue
      fn(fs, 'rmSync')(lock, { recursive: true, force: true })
      throw e
    }
  }
  try {
    return f()
  } finally {
    try {
      const o = readOwner(lock, fs)
      if (o && o.token === token) fn(fs, 'rmSync')(lock, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    } catch {
      // a Windows EBUSY on release never masks f's result or error; a leftover lock goes stale
    }
  }
}

// ==== atomic writes ====

const tmpOf = (p: string): string => `${p}.${process.pid}-${randomUUID()}.tmp`
const RETRY_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES'])

// Writes obj as JSON to a tmp file, then renames it over p. A rename refused with EPERM, EBUSY or EACCES is retried 10 times, 20 ms apart.
export function writeJsonAtomic(p: string, obj: unknown, opts: { fs?: FsLike } = {}): void {
  const { fs } = opts
  const tmp = tmpOf(p)
  fn(fs, 'writeFileSync')(tmp, JSON.stringify(obj, null, 2) + '\n')
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        fn(fs, 'renameSync')(tmp, p)
        return
      } catch (e: any) {
        if (!RETRY_RENAME.has(e.code) || attempt >= 10) throw e
        sleepSync(20)
      }
    }
  } catch (e) {
    try {
      fn(fs, 'unlinkSync')(tmp)
    } catch {
      // the tmp file is already gone
    }
    throw e
  }
}

// Creates p holding obj only when it does not exist: true when this call created it, false on EEXIST. A filesystem without hard links
// (EPERM, ENOTSUP) falls back to an exclusive open; a reader treats an unparseable item as absent.
export function createExclusive(p: string, obj: unknown, opts: { fs?: FsLike } = {}): boolean {
  const { fs } = opts
  const text = JSON.stringify(obj, null, 2) + '\n'
  const tmp = tmpOf(p)
  fn(fs, 'writeFileSync')(tmp, text)
  try {
    try {
      fn(fs, 'linkSync')(tmp, p)
      return true
    } catch (e: any) {
      if (e.code === 'EEXIST') return false
      if (e.code !== 'EPERM' && e.code !== 'ENOTSUP') throw e
    }
    let fd: number
    try {
      fd = fn(fs, 'openSync')(p, 'wx')
    } catch (e: any) {
      if (e.code === 'EEXIST') return false
      throw e
    }
    try {
      fn(fs, 'writeSync')(fd, text)
    } finally {
      fn(fs, 'closeSync')(fd)
    }
    return true
  } finally {
    try {
      fn(fs, 'unlinkSync')(tmp)
    } catch {
      // the tmp file is already gone
    }
  }
}

// ==== jsonl ====

// Appends one JSON line to <dir>/<file> in a single appendFileSync call under the lock <dir>/locks/<lock>.lock.
export function appendJsonl(dir: string, lock: string, file: string, row: unknown): void {
  withLock(dir, lock, () => nodeFs.appendFileSync(`${flat(dir)}/${file}`, JSON.stringify(row) + '\n'))
}

// Reads a jsonl file: the parsed rows and the count of complete lines that did not parse. Tolerates CRLF and a BOM; a last line with
// no newline that does not parse is a write in flight, so it is skipped and not counted. A missing file has no rows.
export function readJsonl(p: string): { rows: Obj[]; bad: number } {
  let text: string
  try {
    text = nodeFs.readFileSync(p, 'utf8')
  } catch (e: any) {
    if (e.code === 'ENOENT') return { rows: [], bad: 0 }
    throw usage(`cannot read ${flat(p)}: ${e.message}`)
  }
  if (text.startsWith('﻿')) text = text.slice(1)
  const lines = text.split('\n')
  const torn = lines.pop() as string // '' after a final newline, else the unterminated last line
  const rows: Obj[] = []
  let bad = 0
  const take = (line: string, last: boolean): void => {
    const l = line.endsWith('\r') ? line.slice(0, -1) : line
    if (l.trim() === '') return
    try {
      const v = JSON.parse(l)
      if (isObj(v)) rows.push(v)
      else bad++
    } catch {
      if (!last) bad++
    }
  }
  for (const line of lines) take(line, false)
  take(torn, true)
  return { rows, bad }
}

// ==== transcripts ====

// Where Claude Code keeps session transcripts: $TRUSS_TRANSCRIPTS_ROOT, else $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects.
// main is <root>/<project>/<sid>.jsonl; agents are <root>/<project>/<sid>/subagents/**/agent-*.jsonl, each with its agent-*.meta.json
// parsed as meta (null when it is not written yet or not JSON).
export function transcriptsOf(sid: string, env: NodeJS.ProcessEnv = process.env): { main: string | null; agents: { path: string; meta: any }[]; root: string } {
  const root = flat(env.TRUSS_TRANSCRIPTS_ROOT || (env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, 'projects') : path.join(homedir(), '.claude', 'projects')))
  const out: { main: string | null; agents: { path: string; meta: any }[]; root: string } = { main: null, agents: [], root }
  if (!/^[A-Za-z0-9._-]+$/.test(sid) || sid === '.' || sid === '..') return out
  let projects: string[]
  try {
    projects = nodeFs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch {
    return out
  }
  const walk = (dir: string): void => {
    let entries: nodeFs.Dirent[]
    try {
      entries = nodeFs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = `${dir}/${e.name}`
      if (e.isDirectory()) walk(full)
      else if (/^agent-.+\.jsonl$/.test(e.name)) {
        let meta: any = null
        try {
          meta = JSON.parse(nodeFs.readFileSync(full.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
        } catch {
          meta = null
        }
        out.agents.push({ path: full, meta })
      }
    }
  }
  for (const proj of projects) {
    const main = `${root}/${proj}/${sid}.jsonl`
    if (out.main === null && nodeFs.existsSync(main)) out.main = main
    walk(`${root}/${proj}/${sid}/subagents`)
  }
  return out
}

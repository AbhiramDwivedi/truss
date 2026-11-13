// truss contract-025 section 2 (ADR-0037): the one place that locks files, writes shared state and finds transcripts, plus the
// helpers every bin module shares. Node built-ins and relative paths only; no module imports factory.ts, which has a top-level await.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
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
// a lock dir with no readable owner.json this old was abandoned between mkdir and the owner write (microseconds on a healthy disk).
// It stays well under withLock's default 5 s wait, so a waiter judges an ownerless lock stale before it gives up with StoreBusy.
const OWNERLESS_MS = 3_000

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

// Deviates from contract-025 section 2 line 83 (rename the stale lock aside, then remove it): renaming a lock aside can move a
// lock that has just turned live, so the .break mutex below replaces the rename. Behaviour is unchanged by this note.
// Removes a stale lock. It never moves the lock aside: a rename of a lock that turned live would open a window where the
// path is free while its owner is still in f (and strand the owner's release). resources/index.ts takeHeavySlot uses it too. Instead one
// breaker at a time holds the mutex <lock>.break, re-reads the owner and removes the lock only if it is still the one
// judged stale (same token). Only a breaker removes a lock it does not own, and only one judged stale: a dead owner on this
// host, an ownerless lock past OWNERLESS_MS, or any lock past STALE_AGE_MS. The age rule can break a live owner's lock that
// has been held longer than STALE_AGE_MS; a live owner within that age is never disturbed.
// On win32 the removal retries, since a scanner can hold a handle for a moment.
export function takeOver(lock: string, seenToken: string | null, platform: NodeJS.Platform, fs?: FsLike): boolean {
  const brk = `${lock}.break`
  try {
    fn(fs, 'mkdirSync')(brk)
  } catch (e: any) {
    if (e.code === 'EEXIST') {
      // another breaker is working; one that died holding the mutex is cleared once it is old
      try {
        const st = fn(fs, 'statSync')(brk) as any
        if (Date.now() - st.mtimeMs > OWNERLESS_MS) {
          // re-check just before the removal: a mutex released and re-taken in the gap is a different directory
          // (the stat-to-remove gap that remains is a few microseconds and a mutex this old is abandoned)
          const again = fn(fs, 'statSync')(brk) as any
          if (again.ino === st.ino && again.mtimeMs === st.mtimeMs) fn(fs, 'rmSync')(brk, { recursive: true, force: true })
        }
      } catch {
        // gone already
      }
    }
    return false
  }
  try {
    const o = readOwner(lock, fs)
    const tok = o && typeof o.token === 'string' ? o.token : null
    if (tok !== seenToken) return false
    // an ownerless lock was judged stale by age: re-check that age under the mutex, so a new holder that mkdir'd a fresh dir
    // after the old one was removed is not taken for the abandoned one
    if (seenToken === null && Date.now() - (fn(fs, 'statSync')(lock) as any).mtimeMs <= OWNERLESS_MS) return false
    fn(fs, 'rmSync')(lock, { recursive: true, force: true, ...(platform === 'win32' ? { maxRetries: 5, retryDelay: 20 } : {}) })
    return true
  } catch {
    return false
  } finally {
    try {
      fn(fs, 'rmSync')(brk, { recursive: true, force: true })
    } catch {
      // a leftover mutex is cleared once it is old
    }
  }
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
  sweepTmp(dir, fs)
  const deadline = Date.now() + waitMs
  let token = ''
  for (;;) {
    try {
      mkdir(lock)
    } catch (e: any) {
      // on win32 a lock dir that is pending delete refuses mkdir with EPERM or EACCES: that is contention, not a fault
      const pending = platform === 'win32' && (e.code === 'EPERM' || e.code === 'EACCES')
      if (e.code !== 'EEXIST' && !pending) throw e
      if (pending) {
        if (Date.now() >= deadline) throw new StoreBusy(name)
        sleepSync(25)
        continue
      }
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
const TMP_NAME = /\.(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/
const TMP_SWEEP_EVERY_MS = 60_000
const TMP_PID_REUSE_MS = 86_400_000 // a tmp this old is swept even when its pid is alive again (a reused pid)
const sweptAt = new Map<string, number>()

// Removes the tmp files a writer left between its write and its rename (writer killed): `<name>.<pid>-<uuid>.tmp` in dir, older
// than STALE_AGE_MS (a live writer holds its tmp for milliseconds) and written by a dead pid, or older than a day. A tmp of a live
// pid is never touched before that. Runs at most once a minute per dir in this process; any failure is ignored, since a sweep is housekeeping.
function sweepTmp(dir: string, fs?: FsLike): void {
  const d = flat(dir)
  const t = Date.now()
  if (t - (sweptAt.get(d) ?? 0) < TMP_SWEEP_EVERY_MS) return
  sweptAt.set(d, t)
  try {
    for (const name of fn(fs, 'readdirSync')(d) as string[]) {
      const m = TMP_NAME.exec(name)
      if (!m) continue
      try {
        const age = t - (fn(fs, 'statSync')(`${d}/${name}`) as any).mtimeMs
        if (age > STALE_AGE_MS && (pidDead(Number(m[1])) || age > TMP_PID_REUSE_MS)) fn(fs, 'unlinkSync')(`${d}/${name}`)
      } catch {
        // gone already, or not ours to remove
      }
    }
  } catch {
    // the directory is not readable
  }
}
const RETRY_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES'])

// Writes obj as JSON to a tmp file, then renames it over p. A rename refused with EPERM, EBUSY or EACCES is retried 10 times, 20 ms apart.
// mode (for a file holding a secret) is the creation mode of the tmp file, so p never exists with a wider one.
export function writeJsonAtomic(p: string, obj: unknown, opts: { fs?: FsLike; mode?: number } = {}): void {
  const { fs, mode } = opts
  sweepTmp(path.posix.dirname(flat(p)), fs)
  const tmp = tmpOf(p)
  fn(fs, 'writeFileSync')(tmp, JSON.stringify(obj, null, 2) + '\n', mode === undefined ? undefined : { mode })
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
  sweepTmp(path.posix.dirname(flat(p)), fs)
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

// ==== leases ====

// A lease is the file <dir>/locks/<name>.lease holding {pid, host, since, refreshed, token}, created with createExclusive. Its holder
// refreshes `refreshed` between its steps (LEASE_REFRESH_MS is the interval it aims for; it never sleeps on it). A lease of another host
// not refreshed for LEASE_STALE_MS is stale, so the refresh interval stays well under the window. A lease of THIS host is judged by its
// pid alone, never by age: the holder blocks its own event loop in spawnSync and cannot refresh, and no process start time is recorded,
// so a lease whose pid was reused by another live process is not recovered and stays until that process exits or the file is deleted.
export const LEASE_STALE_MS = 300_000
export const LEASE_REFRESH_MS = 30_000

export type LeaseOpts = { platform?: NodeJS.Platform; fs?: FsLike; host?: string; now?: () => number; pid?: number }

// Takes the break mutex <lease>.break (the pattern of takeOver: an abandoned one, over OWNERLESS_MS old, is cleared). False when another
// process holds it; the caller then tries again later and never removes or rewrites the lease without it.
function holdBreak(brk: string, fs?: FsLike): boolean {
  try {
    fn(fs, 'mkdirSync')(brk)
    return true
  } catch (e: any) {
    if (e.code === 'EEXIST') {
      try {
        const st = fn(fs, 'statSync')(brk) as any
        if (Date.now() - st.mtimeMs > OWNERLESS_MS) {
          const again = fn(fs, 'statSync')(brk) as any
          if (again.ino === st.ino && again.mtimeMs === st.mtimeMs) fn(fs, 'rmSync')(brk, { recursive: true, force: true })
        }
      } catch {
        // gone already
      }
    }
    return false
  }
}
function dropBreak(brk: string, fs?: FsLike): void {
  try {
    fn(fs, 'rmSync')(brk, { recursive: true, force: true })
  } catch {
    // a leftover mutex is cleared once it is old
  }
}

const readLease = (p: string, fs?: FsLike): Obj | null => {
  try {
    const o = JSON.parse(fn(fs, 'readFileSync')(p, 'utf8') as string)
    return isObj(o) ? o : null
  } catch {
    return null
  }
}

// Runs f on the lease at p while holding its break mutex and only if the lease still carries token (null: an unreadable lease).
// Waits up to waitMs for the mutex. Returns false when the mutex was not won or the token changed.
function underBreak(p: string, token: string | null, waitMs: number, f: () => void, fs?: FsLike): boolean {
  const brk = `${p}.break`
  const deadline = Date.now() + waitMs
  while (!holdBreak(brk, fs)) {
    if (Date.now() >= deadline) return false
    sleepSync(25)
  }
  try {
    const o = readLease(p, fs)
    if ((o && typeof o.token === 'string' ? o.token : null) !== token) return false
    f()
    return true
  } catch {
    return false
  } finally {
    dropBreak(brk, fs)
  }
}

// Takes the lease <dir>/locks/<name>.lease and returns {token}, or null while a live lease holds it. A lease is stale when its host is
// this host and its pid is dead, or when it is of another host and was not refreshed within LEASE_STALE_MS (judged by age only: its
// pid means nothing here). A stale lease is removed by one breaker at a time, which re-reads the token under the mutex <name>.lease.break
// and never renames it aside; the lease is then taken again. A removal that fails (a win32 EPERM or EACCES) leaves the lease and returns
// null, so a later call recovers it. Never throws on contention.
export function takeLease(dir: string, name: string, opts: LeaseOpts = {}): { token: string } | null {
  safeName(name, 'lease name')
  const { platform = process.platform, fs, host = hostname(), now = Date.now, pid = process.pid } = opts
  const locks = `${flat(dir)}/locks`
  const p = `${locks}/${name}.lease`
  fn(fs, 'mkdirSync')(locks, { recursive: true })
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = randomUUID()
    const t = now()
    if (createExclusive(p, { pid, host, since: t, refreshed: t, token }, { fs })) return { token }
    const o = readLease(p, fs)
    let stale: boolean
    if (o) {
      const seen = typeof o.refreshed === 'number' ? o.refreshed : o.since
      // on this host a live pid holds its lease whatever its age: the finisher blocks its own event loop in spawnSync while the
      // acceptance test runs, so it cannot refresh (R-89); another host's lease is judged by age only
      stale = o.host === host ? pidDead(o.pid) : typeof seen !== 'number' || now() - seen > LEASE_STALE_MS
    } else {
      // createExclusive links a complete file, so an unreadable lease is damaged: judge it by the age of the file
      try {
        stale = Date.now() - (fn(fs, 'statSync')(p) as any).mtimeMs > LEASE_STALE_MS
      } catch {
        continue // removed meanwhile
      }
    }
    if (!stale) return null
    const seenToken = o && typeof o.token === 'string' ? o.token : null
    const removed = underBreak(p, seenToken, 0, () => fn(fs, 'rmSync')(p, { force: true, ...(platform === 'win32' ? { maxRetries: 5, retryDelay: 20 } : {}) }), fs)
    if (!removed) return null
  }
  return null
}

// Rewrites `refreshed` of the lease while its token is still token: true when it did, false when the lease is gone or another holder's.
export function refreshLease(dir: string, name: string, token: string, opts: LeaseOpts = {}): boolean {
  safeName(name, 'lease name')
  const { fs, now = Date.now } = opts
  const p = `${flat(dir)}/locks/${name}.lease`
  const o = readLease(p, fs)
  if (!o || o.token !== token) return false
  return underBreak(p, token, 5000, () => writeJsonAtomic(p, { ...o, refreshed: now() }, { fs }), fs)
}

// Removes the lease only while it is still this holder's (token); another holder's lease stays.
export function releaseLease(dir: string, name: string, token: string, opts: LeaseOpts = {}): void {
  safeName(name, 'lease name')
  const { platform = process.platform, fs } = opts
  const p = `${flat(dir)}/locks/${name}.lease`
  const o = readLease(p, fs)
  if (!o || o.token !== token) return
  underBreak(p, token, 5000, () => fn(fs, 'rmSync')(p, { force: true, ...(platform === 'win32' ? { maxRetries: 5, retryDelay: 20 } : {}) }), fs)
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

// The root the inbox proof reads a transcript under: the OS user's home and .claude/projects, never an env var, so the caller cannot point
// the proof at a file of its own. Reading spend (transcriptsOf) grants no authority; a proof does.
export const proofTranscriptRoot = (): string => flat(path.join(userInfo().homedir, '.claude', 'projects'))

// The one read of a transcript for the inbox proof (the tests stub it by re-export, so every proof read goes through it).
export const readProofFile = (p: string, opts: { fs?: FsLike } = {}): Buffer => fn(opts.fs, 'readFileSync')(p) as Buffer

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

// truss ADR-0015 Decision 1: the sampler, the heavy slot lock and the process-group helpers.
// Node built-ins only (P19). Every file it writes lives under <dir>/resources/ of the truss dir.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export const DEFAULT_MIN_FREE_MB = 2048

export type Worktree = { path: string; procs: number; rssMB: number }
export type Sample = { freeMB: number; totalMB: number; cpus?: number; load1?: number; worktrees?: Worktree[] }

const MB = 2 ** 20

/** TRUSS_MIN_FREE_MB when it is a whole number, else the default. */
export function minFreeMB(env: Record<string, string | undefined> = process.env): number {
  const v = env.TRUSS_MIN_FREE_MB
  return typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : DEFAULT_MIN_FREE_MB
}

export function admits(s: Sample, min: number): boolean {
  return s.freeMB >= min
}

function worktreeUsage(root: string): Worktree[] {
  if (process.platform !== 'linux') return []
  const dirs: string[] = []
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) if (e.isDirectory()) dirs.push(`${root.replace(/\/+$/, '')}/${e.name}`)
  } catch {
    return []
  }
  const found = dirs.map((path) => ({ path, procs: 0, rssKB: 0 }))
  let pids: string[] = []
  try {
    pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n))
  } catch {
    return []
  }
  for (const pid of pids) {
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`)
      const w = found.find((f) => cwd === f.path || cwd.startsWith(`${f.path}/`))
      if (!w) continue
      const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
      w.procs += 1
      w.rssKB += m ? Number(m[1]) : 0
    } catch {
      // unreadable or gone: skip it
    }
  }
  return found.map((f) => ({ path: f.path, procs: f.procs, rssMB: Math.round(f.rssKB / 1024) }))
}

/** Reads the host, or TRUSS_SAMPLE (a JSON file; the word `error` or a bad file throws). */
export function sample(opts: { worktreesRoot?: string } = {}): Sample {
  const seam = process.env.TRUSS_SAMPLE
  if (seam !== undefined && seam !== '') {
    if (seam === 'error') throw new Error('TRUSS_SAMPLE=error')
    const o = JSON.parse(readFileSync(seam, 'utf8'))
    const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0
    if (o === null || typeof o !== 'object' || !ok(o.freeMB) || !ok(o.totalMB)) throw new Error('TRUSS_SAMPLE file is not a sample: freeMB and totalMB must be numbers of 0 or more')
    return o
  }
  const s: Sample = { freeMB: Math.round(os.freemem() / MB), totalMB: Math.round(os.totalmem() / MB), cpus: os.availableParallelism() }
  const la = os.loadavg()
  if (!la.every((v) => v === 0)) s.load1 = la[0]
  if (opts.worktreesRoot) s.worktrees = worktreeUsage(opts.worktreesRoot)
  return s
}

// --- the heavy slot (Decision 3) ---

const lockDir = (dir: string) => `${dir}/resources/heavy.lock`

function pidDead(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return false
  } catch (e: any) {
    return e.code === 'ESRCH'
  }
}

function readOwner(lock: string): any {
  try {
    return JSON.parse(readFileSync(`${lock}/owner.json`, 'utf8'))
  } catch {
    return null
  }
}

/** Replaces a stale lock: rename to a unique name, check it is the stale one, rename back if not. */
function takeOver(lock: string, seenToken: string | null): boolean {
  const moved = `${lock}.stale-${process.pid}-${randomUUID()}`
  try {
    renameSync(lock, moved)
  } catch {
    return false
  }
  const o = readOwner(moved)
  const tok = o && typeof o.token === 'string' ? o.token : null
  if (tok !== seenToken) {
    try {
      renameSync(moved, lock)
    } catch {
      rmSync(moved, { recursive: true, force: true })
    }
    return false
  }
  rmSync(moved, { recursive: true, force: true })
  return true
}

/** Takes the one heavy slot. Returns the owner's token, or null while someone else holds it. */
export function takeHeavySlot(dir: string, owner: { label?: string; slug?: string; pid?: number } = {}): string | null {
  const lock = lockDir(dir)
  mkdirSync(`${dir}/resources`, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock)
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e
      const o = readOwner(lock)
      let stale = false
      if (o) stale = pidDead(o.pid)
      else {
        try {
          stale = Date.now() - statSync(lock).mtimeMs > 10000
        } catch {
          stale = false
        }
      }
      if (!stale) return null
      if (!takeOver(lock, o && typeof o.token === 'string' ? o.token : null)) return null
      continue
    }
    const token = randomUUID()
    writeFileSync(`${lock}/owner.json`, JSON.stringify({ pid: owner.pid ?? process.pid, token, label: owner.label ?? '', slug: owner.slug ?? '', since: Date.now() }))
    return token
  }
  return null
}

/** Removes the lock when token is the owner's. Any other token leaves it. */
export function releaseHeavySlot(dir: string, token: string): void {
  const lock = lockDir(dir)
  const o = readOwner(lock)
  if (o && o.token === token) rmSync(lock, { recursive: true, force: true })
}

// --- process groups (Decision 4): signal a recorded group, never a pattern ---

export function groupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch (e: any) {
    return e.code === 'EPERM'
  }
}

export function killGroup(pgid: number, signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false
  try {
    process.kill(-pgid, signal)
    return true
  } catch {
    return false
  }
}

// --- script mode: node resources/index.ts [--worktrees <root>] ---

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--worktrees')
  const root = i >= 0 ? process.argv[i + 1] : undefined
  console.log(JSON.stringify(sample(root ? { worktreesRoot: root } : {})))
}

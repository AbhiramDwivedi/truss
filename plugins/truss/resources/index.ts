// truss ADR-0015 Decision 1: the sampler, the heavy slot lock and the process-group helpers.
// Node built-ins only (P19). Every file it writes lives under <dir>/resources/ of the truss dir.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { takeOver } from '../bin/store.ts'

export const DEFAULT_MIN_FREE_MB = 2048

export type Worktree = { path: string; procs: number; rssMB: number }
export type Sample = { freeMB: number; totalMB: number; cpus?: number; load1?: number; worktrees?: Worktree[]; memPressure?: number; swapUsedPct?: number }
export type Pressure = { memPressure?: number; swapUsedPct?: number }

const MB = 2 ** 20

const pct = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100

/** ADR-0026 item 57: the PSI `some` avg10 and the swap used percent; a field is left out when its file is absent or unreadable. */
export function pressureOf(paths: { pressure?: string; meminfo?: string } = {}): Pressure {
  const out: Pressure = {}
  try {
    const m = /^some\b.*?\bavg10=([\d.]+)/m.exec(readFileSync(paths.pressure ?? '/proc/pressure/memory', 'utf8'))
    const v = m ? Number(m[1]) : NaN
    if (pct(v)) out.memPressure = v
  } catch {
    // absent or unreadable: leave memPressure out
  }
  try {
    const t = readFileSync(paths.meminfo ?? '/proc/meminfo', 'utf8')
    const total = /^SwapTotal:\s+(\d+)/m.exec(t)
    const free = /^SwapFree:\s+(\d+)/m.exec(t)
    if (total && free && Number(total[1]) > 0) {
      const v = Math.round(((Number(total[1]) - Number(free[1])) / Number(total[1])) * 100)
      if (pct(v)) out.swapUsedPct = v
    }
  } catch {
    // absent or unreadable: leave swapUsedPct out
  }
  return out
}

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
    for (const k of ['memPressure', 'swapUsedPct']) {
      if (k in o && !pct(o[k])) throw new Error(`TRUSS_SAMPLE file is not a sample: ${k} must be a number from 0 to 100`)
    }
    return o
  }
  const s: Sample = { freeMB: Math.round(os.freemem() / MB), totalMB: Math.round(os.totalmem() / MB), cpus: os.availableParallelism(), ...pressureOf() }
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

// A stale lock is removed by store.ts takeOver: one breaker at a time holds <lock>.break and removes the lock only while its
// token is still the one judged stale. It never renames the lock aside, which could move a lock that has just turned live.
/** Takes the one heavy slot. Returns the owner's token, or null while someone else holds it. */
export function takeHeavySlot(dir: string, owner: { label?: string; slug?: string; pid?: number } = {}, platform: string = process.platform): string | null {
  const lock = lockDir(dir)
  mkdirSync(`${dir}/resources`, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock)
    } catch (e: any) {
      // on win32 a lock dir that is pending delete refuses mkdir with EPERM or EACCES: that is contention, not a fault
      if (platform === 'win32' && (e.code === 'EPERM' || e.code === 'EACCES')) return null
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
      if (!takeOver(lock, o && typeof o.token === 'string' ? o.token : null, platform)) return null
      continue
    }
    const token = randomUUID()
    writeFileSync(`${lock}/owner.json`, JSON.stringify({ pid: owner.pid ?? process.pid, token, label: owner.label ?? '', slug: owner.slug ?? '', since: Date.now() }))
    return token
  }
  return null
}

/** Removes the lock when token is the owner's. Any other token leaves it. */
export function releaseHeavySlot(dir: string, token: string, platform: string = process.platform, rm: typeof rmSync = rmSync): void {
  const lock = lockDir(dir)
  const o = readOwner(lock)
  if (o && o.token === token) rm(lock, platform === 'win32' ? { recursive: true, force: true, maxRetries: 5, retryDelay: 20 } : { recursive: true, force: true })
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

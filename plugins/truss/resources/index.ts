// truss ADR-0015 Decision 1: the sampler, the heavy slot lock and the process-group helpers.
// Node built-ins only (P19). Every file it writes lives under <dir>/resources/ of the truss dir.
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { takeOver } from '../bin/lock.ts'

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

/**
 * macOS os.freemem() counts only strictly free pages; inactive and speculative pages are reclaimed on
 * demand, so available memory is free + inactive + speculative (as Linux MemAvailable). Null if unparsable.
 */
export function darwinAvailableMB(vmStatText: string): number | null {
  const size = /page size of (\d+) bytes/.exec(vmStatText)
  if (!size) return null
  const pageSize = Number(size[1])
  let pages = 0
  for (const name of ['free', 'inactive', 'speculative']) {
    const m = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(vmStatText)
    if (!m) return null
    pages += Number(m[1])
  }
  if (!(pageSize > 0)) return null
  return Math.round((pages * pageSize) / MB)
}

function freeMBOf(platform: string, vmStat: () => string): number {
  if (platform === 'darwin') {
    try {
      const mb = darwinAvailableMB(vmStat())
      if (mb !== null) return mb
    } catch {
      // vm_stat missing or slow: fall back to os.freemem
    }
  }
  return Math.round(os.freemem() / MB)
}

/** Reads the host, or TRUSS_SAMPLE (a JSON file; the word `error` or a bad file throws). */
export function sample(opts: { worktreesRoot?: string; platform?: string; vmStat?: () => string } = {}): Sample {
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
  const s: Sample = { freeMB: freeMBOf(opts.platform ?? process.platform, opts.vmStat ?? (() => execFileSync('vm_stat', { encoding: 'utf8', timeout: 2000, windowsHide: true }))), totalMB: Math.round(os.totalmem() / MB), cpus: os.availableParallelism(), ...pressureOf() }
  const la = os.loadavg()
  if (!la.every((v) => v === 0)) s.load1 = la[0]
  if (opts.worktreesRoot) s.worktrees = worktreeUsage(opts.worktreesRoot)
  return s
}

// --- the heavy slot (Decision 3) ---

// ADR-0046 item 4: slot 1 is heavy.lock (the name before 0.29.0), slot n > 1 is heavy-<n>.lock.
const lockDir = (dir: string, n = 1) => path.join(dir, 'resources', n === 1 ? 'heavy.lock' : `heavy-${n}.lock`)
const SLOT_LOCK = /^heavy(-[1-9]\d*)?\.lock$/

export const MAX_HEAVY_SLOTS = 4

/** ADR-0046 item 4: the host's default slot count, max(1, min(4, floor(cpus/4), floor(totalGB/8))). */
export function defaultHeavySlots(cpus: number = os.availableParallelism(), totalBytes: number = os.totalmem()): number {
  const n = Math.min(MAX_HEAVY_SLOTS, Math.floor(cpus / 4), Math.floor(totalBytes / 2 ** 33))
  return Number.isFinite(n) && n >= 1 ? n : 1
}

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
/** Takes the first free of `slots` heavy slots (heavy.lock, heavy-2.lock, ...). Returns the owner's token, or null while every slot is held. */
// owner.until (epoch ms) is the holder's deadline: a lock past it is stale even while its pid lives, and its holder is stopped first.
export function takeHeavySlot(dir: string, owner: { label?: string; slug?: string; pid?: number; until?: number } = {}, platform: string = process.platform, slots = 1, spawn: typeof spawnSync = spawnSync): string | null {
  mkdirSync(`${dir}/resources`, { recursive: true })
  const n = Number.isInteger(slots) && slots >= 1 ? slots : 1
  for (let i = 1; i <= n; i++) {
    const token = takeSlot(lockDir(dir, i), owner, platform, spawn)
    if (token !== null) return token
  }
  return null
}

function takeSlot(lock: string, owner: { label?: string; slug?: string; pid?: number; until?: number }, platform: string, spawn: typeof spawnSync): string | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock)
    } catch (e: any) {
      // on win32 a lock dir that is pending delete refuses mkdir with EPERM or EACCES: that is contention, not a fault
      if (platform === 'win32' && (e.code === 'EPERM' || e.code === 'EACCES')) return null
      if (e.code !== 'EEXIST') throw e
      const o = readOwner(lock)
      let stale = false
      if (o) {
        stale = pidDead(o.pid)
        if (!stale && typeof o.until === 'number' && Date.now() > o.until) {
          // hung past its deadline: stop the holder (only the lock this waiter judged, by token) so its slot is free
          stale = true
          const again = readOwner(lock)
          if (again && again.token === o.token && o.pid !== process.pid) stopHolder(path.dirname(lock), o.pid, platform, spawn)
        }
      } else {
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
    writeFileSync(`${lock}/owner.json`, JSON.stringify({ pid: owner.pid ?? process.pid, token, label: owner.label ?? '', slug: owner.slug ?? '', since: Date.now(), ...(typeof owner.until === 'number' ? { until: owner.until } : {}) }))
    return token
  }
  return null
}

/** Removes the slot lock whose owner holds token, whichever slot it is. Any other token leaves every lock. */
export function releaseHeavySlot(dir: string, token: string, platform: string = process.platform, rm: typeof rmSync = rmSync): void {
  let names: string[] = []
  try {
    names = readdirSync(path.join(dir, 'resources')).filter((n) => SLOT_LOCK.test(n))
  } catch {
    return
  }
  for (const name of names) {
    const lock = path.join(dir, 'resources', name)
    const o = readOwner(lock)
    if (o && o.token === token) {
      rm(lock, platform === 'win32' ? { recursive: true, force: true, maxRetries: 5, retryDelay: 20 } : { recursive: true, force: true })
      return
    }
  }
}

// --- process groups (Decision 4): signal a recorded group, never a pattern ---

// On win32 there are no negative-pid signals: a group is its leader's pid, alive while that pid is, and killed as a tree by taskkill.
export function groupAlive(pgid: number, platform: string = process.platform): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false
  try {
    process.kill(platform === 'win32' ? pgid : -pgid, 0)
    return true
  } catch (e: any) {
    return e.code === 'EPERM'
  }
}

export function killGroup(pgid: number, signal: NodeJS.Signals | number = 'SIGTERM', platform: string = process.platform, spawn: typeof spawnSync = spawnSync): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false
  if (platform === 'win32') return treeKill(pgid, spawn)
  try {
    process.kill(-pgid, signal)
    return true
  } catch {
    return false
  }
}

/** win32: `taskkill /pid <pid> /T /F` stops the pid and every process it started. True when taskkill reports success. */
export function treeKill(pid: number, spawn: typeof spawnSync = spawnSync): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    return spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).status === 0
  } catch {
    return false
  }
}

// A heavy slot held past its `until`: stops the groups its owner's wrapper recorded (resources/groups, heavyPid = the owner pid), then
// the owner pid itself, so the next waiter takes a free machine. Every failure is ignored: the takeover that follows decides.
function stopHolder(resources: string, pid: number, platform: string, spawn: typeof spawnSync): void {
  let names: string[] = []
  try {
    names = readdirSync(`${resources}/groups`)
  } catch {
    names = []
  }
  for (const name of names) {
    try {
      const rec = JSON.parse(readFileSync(`${resources}/groups/${name}`, 'utf8'))
      if (rec && rec.heavyPid === pid && Number.isInteger(rec.pgid)) {
        killGroup(rec.pgid, 'SIGKILL', platform, spawn)
        rmSync(`${resources}/groups/${name}`, { force: true })
      }
    } catch {
      // an unreadable record is the reap's to sort out
    }
  }
  if (platform === 'win32') {
    treeKill(pid, spawn)
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

// --- script mode: node resources/index.ts [--worktrees <root>] ---

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--worktrees')
  const root = i >= 0 ? process.argv[i + 1] : undefined
  console.log(JSON.stringify(sample(root ? { worktreesRoot: root } : {})))
}

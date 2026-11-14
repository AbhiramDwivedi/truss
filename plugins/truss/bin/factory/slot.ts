// The heavy slot (ADR-0015): the wait, the slot count, acquire, the recorded suite times, pidAlive and the reap group dir. Split from
// bin/factory/resources.ts (0.32.0 item 8). Never imports factory.ts, whose top-level await would make an import cycle.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { configOf, flat, str } from '../core.ts'
import type { Flags, Obj } from '../core.ts'
import { admits, defaultHeavySlots, minFreeMB, releaseHeavySlot, sample, takeHeavySlot } from '../../resources/index.ts'
import { run } from './cli.ts'
import { appendEvent } from './log.ts'

// How long a heavy run waits for the slot and free memory: --wait-ms N, else TRUSS_HEAVY_WAIT_MS, else slotWaitMs(dir), which
// scales with the measured suite time (0.31.0 item 2). The wait happens in a background job (heavyJobMain), so it is no longer
// bounded by the runner's 600 s Bash timeout; the caller only waits HEAVY_ATTACH_MS for the result.
export const HEAVY_WAIT_MS = 540000
export const HEAVY_WAIT_MAX_MS = 2 * 3600 * 1000
const HEAVY_TIMES = (dir: string): string => `${dir}/resources/heavy-times.jsonl`
export function explicitWaitMs(f: Flags, env: Record<string, string | undefined> = process.env): number | undefined {
  for (const v of [str(f, 'wait-ms'), env.TRUSS_HEAVY_WAIT_MS]) {
    const n = v === undefined || v.trim() === '' ? NaN : Number(v)
    if (Number.isInteger(n) && n >= 0) return n
  }
  return undefined
}
export function heavyWaitMs(f: Flags, env: Record<string, string | undefined> = process.env, dir?: string): number {
  return explicitWaitMs(f, env) ?? (dir === undefined ? HEAVY_WAIT_MS : slotWaitMs(dir))
}
// Twice the longest of the last 10 slot runs recorded in <dir>/resources/heavy-times.jsonl (one suite running, one ahead of the
// waiter), never below HEAVY_WAIT_MS and never above HEAVY_WAIT_MAX_MS; HEAVY_WAIT_MS when nothing is recorded yet.
// A row the run limit stopped carries timedOut: true; it is no suite time, so slotWaitMs skips it (a hang never stretches the wait).
function recentRows(dir: string): { ms: number; timedOut: boolean }[] {
  try {
    return readFileSync(HEAVY_TIMES(dir), 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => {
      try {
        const r = JSON.parse(l)
        return { ms: Number(r.ms), timedOut: r.timedOut === true }
      } catch {
        return { ms: NaN, timedOut: false }
      }
    }).filter((r) => Number.isFinite(r.ms) && r.ms > 0).slice(-10)
  } catch {
    return []
  }
}
export function slotWaitMs(dir: string): number {
  const ms = recentRows(dir).filter((r) => !r.timedOut).map((r) => r.ms)
  if (ms.length === 0) return HEAVY_WAIT_MS
  return Math.min(HEAVY_WAIT_MAX_MS, Math.max(HEAVY_WAIT_MS, 2 * Math.max(...ms)))
}
export function recordHeavyTime(dir: string, row: { label: string; slug: string; ms: number; timedOut?: boolean }): void {
  try {
    mkdirSync(`${dir}/resources`, { recursive: true })
    appendFileSync(HEAVY_TIMES(dir), JSON.stringify({ ...row, at: new Date().toISOString() }) + '\n')
  } catch {
    // a lost row only makes the next wait shorter
  }
}
// How long a command that holds a heavy slot may run (R-145): TRUSS_HEAVY_RUN_MS, else slotWaitMs(dir). Past it the heavy job stops the
// command's group; HEAVY_GRACE_MS later the slot's `until` deadline lets a waiter take the slot from a holder that never got that far.
export const HEAVY_GRACE_MS = 15000
export function runMsOf(dir: string, env: Record<string, string | undefined> = process.env): number {
  const v = env.TRUSS_HEAVY_RUN_MS
  const n = v === undefined || v.trim() === '' ? NaN : Number(v)
  if (Number.isInteger(n) && n > 0) return n
  // a suite longer than the limit is stopped and never recorded as a suite time, so the limit would never grow to fit it: a stopped
  // run still stretches the next default limit (twice the longest of them), up to HEAVY_WAIT_MAX_MS
  const stopped = recentRows(dir).filter((r) => r.timedOut).map((r) => r.ms)
  return stopped.length === 0 ? slotWaitMs(dir) : Math.min(HEAVY_WAIT_MAX_MS, Math.max(slotWaitMs(dir), 2 * Math.max(...stopped)))
}
// Takes one of `slots` heavy slots once free memory admits a run, waiting up to limitMs. The token is null when the wait ran out.
// The slot's owner.json carries until = now + the run limit + HEAVY_GRACE_MS, which takeHeavySlot treats as a stale deadline.
export function acquireSlot(dir: string, owner: { label: string; slug: string }, slots: number, limitMs: number, platform: NodeJS.Platform = process.platform): { token: string | null; waitedMs: number } {
  const t0 = Date.now()
  const runMs = runMsOf(dir)
  for (;;) {
    const token = takeHeavySlot(dir, { ...owner, pid: process.pid, until: Date.now() + runMs + HEAVY_GRACE_MS }, platform, slots)
    if (token !== null) {
      let low = false
      try {
        low = !admits(sample(), minFreeMB())
      } catch (e) {
        appendEvent(dir, { event: 'sampler-error', crew: owner.slug, agent: owner.slug, command: 'heavy', error: (e instanceof Error ? e.message : String(e)).slice(0, 200) })
      }
      if (!low) return { token, waitedMs: Date.now() - t0 }
      releaseHeavySlot(dir, token, platform)
    }
    if (Date.now() - t0 >= limitMs) return { token: null, waitedMs: Date.now() - t0 }
    sleepSync(500)
  }
}
export const slotsAt = (cwd: string): number => {
  const top = run(cwd, ['rev-parse', '--show-toplevel'])
  return heavySlotsOf(configOf(top.status === 0 ? flat(top.out) : cwd))
}

// ADR-0046 item 4: how many heavy commands may run at once. truss.json `heavySlots` (a whole number 1-16) of the repo the
// command runs in, else TRUSS_HEAVY_SLOTS, else the host default (defaultHeavySlots: max(1, min(4, cpus/4, totalGB/8))).
export function heavySlotsOf(cfg: Obj, env: Record<string, string | undefined> = process.env, host: () => number = defaultHeavySlots): number {
  const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 16
  if (ok(cfg.heavySlots)) return cfg.heavySlots
  const e = env.TRUSS_HEAVY_SLOTS
  if (typeof e === 'string' && /^\d+$/.test(e) && ok(Number(e))) return Number(e)
  return host()
}
export const sleepSync = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
// True while pid runs: process.kill(pid, 0), which works on every OS. On Linux a zombie counts as gone; elsewhere a live answer
// stands (no /proc, and truss reads no system process table), which only ever keeps a group from being reaped.
export const pidAlive = (pid: unknown, platform: NodeJS.Platform = process.platform): boolean => {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (e: any) {
    return e.code === 'EPERM'
  }
  if (platform !== 'linux') return true
  try {
    // a zombie has exited: its parent has not collected it yet
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return true
  }
}

export const GROUPS = (dir: string): string => `${dir}/resources/groups`

// Resources (ADR-0015): the heavy slot and its wait, admit, reap and start's admission. Moved unchanged from bin/factory.ts
// (0.31.0 item 5). Never imports factory.ts, whose top-level await would make an import cycle.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { configOf, flat, isObj, need, parseLabel, refuse, StoreBusy, str, usage } from '../store.ts'
import type { Flags, Obj } from '../store.ts'
import { admits, defaultHeavySlots, groupAlive, killGroup, minFreeMB, releaseHeavySlot, sample, takeHeavySlot } from '../../resources/index.ts'
import { blockingFor, escalate } from '../inbox.ts'
import { budgetVerdict } from '../cost.ts'
import { eventsOf } from './runs.ts'
import { appendEvent, dirOf, intOr, loadPlan, repoOf, run } from './shared.ts'

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
export function slotWaitMs(dir: string): number {
  let ms: number[] = []
  try {
    ms = readFileSync(HEAVY_TIMES(dir), 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => {
      try {
        return Number(JSON.parse(l).ms)
      } catch {
        return NaN
      }
    }).filter((n) => Number.isFinite(n) && n > 0).slice(-10)
  } catch {
    ms = []
  }
  if (ms.length === 0) return HEAVY_WAIT_MS
  return Math.min(HEAVY_WAIT_MAX_MS, Math.max(HEAVY_WAIT_MS, 2 * Math.max(...ms)))
}
export function recordHeavyTime(dir: string, row: { label: string; slug: string; ms: number }): void {
  try {
    mkdirSync(`${dir}/resources`, { recursive: true })
    appendFileSync(HEAVY_TIMES(dir), JSON.stringify({ ...row, at: new Date().toISOString() }) + '\n')
  } catch {
    // a lost row only makes the next wait shorter
  }
}
// Takes one of `slots` heavy slots once free memory admits a run, waiting up to limitMs. The token is null when the wait ran out.
export function acquireSlot(dir: string, owner: { label: string; slug: string }, slots: number, limitMs: number): { token: string | null; waitedMs: number } {
  const t0 = Date.now()
  for (;;) {
    const token = takeHeavySlot(dir, { ...owner, pid: process.pid }, process.platform, slots)
    if (token !== null) {
      let low = false
      try {
        low = !admits(sample(), minFreeMB())
      } catch (e) {
        appendEvent(dir, { event: 'sampler-error', crew: owner.slug, agent: owner.slug, command: 'heavy', error: (e instanceof Error ? e.message : String(e)).slice(0, 200) })
      }
      if (!low) return { token, waitedMs: Date.now() - t0 }
      releaseHeavySlot(dir, token)
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
const sleepSync = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
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

// D/resources/parallelism.json counts only as an integer from 1 to the cap; anything else means the cap.
function effectiveParallelism(dir: string, cap: number): number {
  try {
    const v = JSON.parse(readFileSync(`${dir}/resources/parallelism.json`, 'utf8'))
    if (isObj(v) && Number.isInteger(v.parallelism) && v.parallelism >= 1 && v.parallelism <= cap) return v.parallelism
  } catch {
    // missing or bad: the cap
  }
  return cap
}

type Admission = { admitted: boolean; parallelism: number; running: number; freeMB: number | null; minFreeMB: number; memPressure?: number; swapUsedPct?: number; why?: string; budget?: true; awaiting?: true; scope?: string; spentUsd?: number | null; limitUsd?: number; escalateError?: string }
const MAX_MEM_PRESSURE = 10
const MAX_SWAP_USED_PCT = 70
// contract-025 section 3: blocking inbox items first, then (only when truss.json sets a budget) the budget verdict; a hold here never waits.
// A budget hold also writes one budget-hold event and one budget escalation (ref budget:<sid>:<scope>:<slug|run>); a throwing escalate never lifts the hold.
function holdOf(dir: string, repo: string, plan: Obj, slug: string, command: string, base: Omit<Admission, 'admitted'>): Admission | undefined {
  const sid = path.basename(dir)
  const ids = blockingFor(repo, sid, slug)
  if (ids.length > 0) return { admitted: false, ...base, awaiting: true, why: `awaiting client: ${ids.join(', ')}` }
  if (!isObj(configOf(repo).budget)) return undefined
  const v = budgetVerdict(dir, repo, plan, slug)
  if (!v.held) return undefined
  // one event per hold: a repeat admit under the same crew, scope and limit writes none (a raised limit is a new hold)
  const last = eventsOf(dir).filter((e) => e.event === 'budget-hold' && e.crew === slug && e.scope === v.scope).pop()
  if (last === undefined || last.limitUsd !== v.limitUsd) appendEvent(dir, { event: 'budget-hold', crew: slug, scope: v.scope, spentUsd: v.spentUsd, limitUsd: v.limitUsd })
  let escalateError: string | undefined
  let clientNote = ''
  try {
    const esc = escalate(repo, dir, { kind: 'budget', title: `budget: ${v.why}`.slice(0, 200), detail: `${v.why}\nscope ${v.scope}, spent ${v.spentUsd === null ? 'unknown' : `${v.spentUsd} USD`}, limit ${v.limitUsd} USD; held at ${command} of crew ${slug}`, crews: [slug], ref: typeof (v as Obj).ref === 'string' && (v as Obj).ref !== '' ? String((v as Obj).ref) : `budget:${sid}:${v.scope}:${v.scope === 'run' ? 'run' : slug}`, blocking: true })
    // the one-time code exists only in this return value (the inbox keeps its hash); with no notify command nothing else delivers it, so the held entry carries it for the PM to relay
    if (!esc.deduped && esc.code !== '' && esc.notified !== true) clientNote = `; client approval needed: ${esc.id} code ${esc.code} (relay to the client, who types /truss:inbox approve ${esc.id} ${esc.code} raise <usd>)`
  } catch (e) {
    escalateError = (e instanceof Error ? e.message : String(e)).slice(0, 200)
  }
  return { admitted: false, ...base, budget: true, scope: v.scope, spentUsd: v.spentUsd, limitUsd: v.limitUsd, why: v.why + clientNote, ...(escalateError === undefined ? {} : { escalateError }) }
}

// Memory first (free MB, then memory pressure and swap use, ADR-0026 item 57), then (for a planned crew) the effective parallelism. A sampler error admits and logs a sampler-error event.
export function admission(dir: string, repo: string, plan: Obj, crew: Obj, command: string, running: number): Admission {
  const slug = String(crew.slug)
  const cap = intOr(plan.maxParallelCrews, 4, 1)
  const parallelism = effectiveParallelism(dir, cap)
  const min = minFreeMB()
  const held = holdOf(dir, repo, plan, slug, command, { parallelism, running, freeMB: null, minFreeMB: min })
  if (held !== undefined) return held
  let freeMB: number | null = null
  // ADR-0026 item 57: the sampler's memory pressure (PSI some avg10, %) and swap use (%), read as optional numbers here
  // until resources/index.ts types them; an absent or non-numeric field skips its rule
  let pressure: { memPressure?: unknown; swapUsedPct?: unknown } = {}
  try {
    const s = sample()
    freeMB = s.freeMB
    pressure = s as unknown as typeof pressure
  } catch (e) {
    appendEvent(dir, { event: 'sampler-error', crew: slug, agent: slug, command, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) })
  }
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const memPressure = num(pressure.memPressure)
  const swapUsedPct = num(pressure.swapUsedPct)
  const base = { parallelism, running, freeMB, minFreeMB: min, ...(memPressure === undefined ? {} : { memPressure }), ...(swapUsedPct === undefined ? {} : { swapUsedPct }) }
  if (freeMB !== null && !admits({ freeMB, totalMB: 0 }, min)) return { admitted: false, ...base, why: `free memory ${freeMB} MB is below ${min} MB` }
  // strict limits: exactly 10% and 70% admit; well before systemd-oomd's 50% pressure and 90% swap kill switch
  if (memPressure !== undefined && memPressure > MAX_MEM_PRESSURE) return { admitted: false, ...base, why: `memory pressure ${memPressure}% (PSI some avg10) is above ${MAX_MEM_PRESSURE}%` }
  if (swapUsedPct !== undefined && swapUsedPct > MAX_SWAP_USED_PCT) return { admitted: false, ...base, why: `swap use ${swapUsedPct}% is above ${MAX_SWAP_USED_PCT}%` }
  if (crew.status === 'planned' && running >= parallelism) return { admitted: false, ...base, why: `${running} crew(s) running already fill the parallelism ${parallelism}` }
  return { admitted: true, ...base }
}

export function cmdAdmit(f: Flags): Obj {
  const dir = dirOf(f)
  const slug = need(f, 'slug')
  const plan = loadPlan(dir)
  const crew = plan.crews.find((c: Obj) => isObj(c) && c.slug === slug)
  if (crew === undefined) throw usage(`no crew ${slug} in the plan`)
  const running = (): number => plan.crews.filter((c: Obj) => isObj(c) && c.status === 'running').length
  const repo = repoOf(f)
  let a = admission(dir, repo, plan, crew, 'admit', running())
  // --wait-ms N: a hold re-checks every 2 s for up to N ms (bounded) before it refuses, so a short memory dip does not stop the crew
  const waitMs = Math.min(intOr(Number(str(f, 'wait-ms') ?? 0), 0, 0), 600000)
  const t0 = Date.now()
  // an awaiting or budget hold waits for the client, not for memory, so it ends the wait at once
  while (!a.admitted && !a.budget && !a.awaiting && Date.now() - t0 < waitMs) {
    sleepSync(Math.min(2000, Math.max(1, waitMs - (Date.now() - t0))))
    a = admission(dir, repo, plan, crew, 'admit', running())
  }
  if (!a.admitted) throw refuse({ ...a, ...(waitMs > 0 ? { waitedMs: Date.now() - t0 } : {}) })
  // ADR-0015 Decision 6: --label and --title together record the agent's card title for the UI
  const label = str(f, 'label')
  const title = str(f, 'title')
  if (label !== undefined || title !== undefined) {
    if (label === undefined || title === undefined) throw usage('--label and --title go together')
    if (parseLabel(label) === undefined) throw usage(`--label ${label} is not a workflow label`)
    const one = title.replace(/\s+/g, ' ').trim().slice(0, 120)
    if (one === '') throw usage('--title is empty')
    // ADR-0032: --persona names the persona the spawn runs as; recordRun copies it onto the spawn event
    const persona = str(f, 'persona')
    if (persona !== undefined && !/^[A-Za-z0-9][\w.-]{0,99}$/.test(persona)) throw usage(`--persona ${persona} is not a persona name`)
    appendEvent(dir, { event: 'title', crew: slug, agent: label, label, title: one, ...(persona !== undefined ? { persona } : {}), ...(f.high === true ? { high: true } : {}) })
  }
  return a
}

export const GROUPS = (dir: string): string => `${dir}/resources/groups`

export function cmdReap(f: Flags): Obj {
  const dir = dirOf(f)
  const slug = need(f, 'slug')
  const label = need(f, 'label')
  const reaped: number[] = []
  const skipped: number[] = []
  const gdir = GROUPS(dir)
  for (const name of existsSync(gdir) ? readdirSync(gdir) : []) {
    const file = `${gdir}/${name}`
    let rec: Obj
    try {
      rec = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (!isObj(rec) || rec.slug !== slug || rec.label !== label || !Number.isInteger(rec.pgid)) continue
    if (pidAlive(rec.heavyPid)) {
      skipped.push(rec.pgid)
      continue
    }
    if (groupAlive(rec.pgid)) {
      killGroup(rec.pgid, 'SIGTERM')
      for (let i = 0; i < 20 && groupAlive(rec.pgid); i++) sleepSync(100)
      if (groupAlive(rec.pgid)) killGroup(rec.pgid, 'SIGKILL')
    }
    rmSync(file, { force: true })
    reaped.push(rec.pgid)
  }
  return { reaped, skipped }
}
// start's admission: a busy usage lock with no reading (StoreBusy from budgetVerdict, ADR-0038 amendment 2026-11-11) is never an
// admit. start holds that crew with why `store busy: usage` and still reports the crews it already started in this call.
export function heldOnBusy(f: () => Admission): Admission {
  try {
    return f()
  } catch (e) {
    if (!(e instanceof StoreBusy)) throw e
    return { admitted: false, parallelism: 0, running: 0, freeMB: null, minFreeMB: 0, why: String(e.body.error) }
  }
}

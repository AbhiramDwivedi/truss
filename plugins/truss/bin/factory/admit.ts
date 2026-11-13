// start's and admit's admission (ADR-0015, contract-025): blocking inbox items, the budget hold, memory, then the parallelism. Split
// from bin/factory/resources.ts (0.32.0 item 8). Never imports factory.ts, whose top-level await would make an import cycle.
import path from 'node:path'
import { configOf, isObj, need, parseLabel, refuse, str, usage } from '../core.ts'
import type { Flags, Obj } from '../core.ts'
import { StoreBusy } from '../lock.ts'
import { admits, minFreeMB, sample } from '../../resources/index.ts'
import { blockingFor, escalate } from '../inbox.ts'
import { budgetVerdict } from '../cost.ts'
import { eventsOf } from './runs.ts'
import { dirOf, intOr, repoOf } from './cli.ts'
import { appendEvent } from './log.ts'
import { loadPlan } from './plan-file.ts'
import { sleepSync } from './slot.ts'

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

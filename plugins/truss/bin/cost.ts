// Spend, budgets and the cost command (contract-025 section 4, ADR-0038).
// The meter is a sweep of the session's transcripts into D/usage.jsonl under the lock D/locks/usage; attribution to a crew is resolved at read time.
// No price is written here: prices come from the client's `pricing` config. Imports node: builtins and relative paths only, and never factory.ts
// (its top-level await would make an import cycle).

import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import path from 'node:path'
import { budgetRaises } from './inbox.ts'
import { StoreBusy, configOf, flat, isObj, need, parseLabel, readJson, readJsonl, str, transcriptsOf, withLock, writeJsonAtomic } from './store.ts'
import type { Flags, Obj } from './store.ts'

export type BudgetVerdict = { held: false } | { held: true; scope: 'run' | 'crew' | 'workType' | 'session'; spentUsd: number | null; limitUsd: number; why: string }
export type SweepOut = { rows: number; files: number; bad: number; found: number; unswept?: true }
type SweepOpts = { platform?: NodeJS.Platform; waitMs?: number }

const CHUNK = 4 * 1024 * 1024 // a transcript is read in chunks of this size, each cut at its last newline
const MAIN = 'main'
const UNATTRIBUTED = 'unattributed'

// ==== sweep ====

const count = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}
const iso = (v: unknown): string => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : new Date().toISOString())

// One usage row from a transcript line, or undefined when it is not an assistant line with usage, or its token fields are all zero (<synthetic>).
function rowOf(line: Obj, sid: string, agentId: string | null): Obj | undefined | 'bad' {
  if (line.type !== 'assistant' || !isObj(line.message) || !isObj(line.message.usage)) return undefined
  const m = line.message
  const u = m.usage
  const cc = isObj(u.cache_creation) ? u.cache_creation : undefined
  const row = {
    v: 1,
    ts: iso(line.timestamp),
    sid,
    agentId,
    model: typeof m.model === 'string' ? m.model : 'unknown',
    speed: u.speed === 'fast' ? 'fast' : 'standard',
    msgId: typeof m.id === 'string' && m.id !== '' ? m.id : typeof line.uuid === 'string' ? line.uuid : '',
    in: count(u.input_tokens),
    out: count(u.output_tokens),
    think: count(u.thinking_tokens),
    cr: count(u.cache_read_input_tokens),
    cw5m: cc ? count(cc.ephemeral_5m_input_tokens) : count(u.cache_creation_input_tokens),
    cw1h: cc ? count(cc.ephemeral_1h_input_tokens) : 0,
    web: isObj(u.server_tool_use) ? count(u.server_tool_use.web_search_requests) : 0,
  }
  if (row.in + row.out + row.think + row.cr + row.cw5m + row.cw1h + row.web === 0) return undefined
  return row.msgId === '' ? 'bad' : row
}

const agentIdOf = (p: string): string => path.basename(p).replace(/^agent-/, '').replace(/\.jsonl$/, '')

/** Reads every transcript of the session `dir` names from its cursor and appends the new usage rows to D/usage.jsonl, once per msgId. Throws StoreBusy when the lock stays busy. */
export function sweep(dir: string, repo?: string, opts: SweepOpts = {}): SweepOut {
  const platform = opts.platform ?? process.platform
  const sid = path.basename(flat(dir))
  const keyOf = (p: string): string => (platform === 'win32' ? flat(p).toLowerCase() : flat(p))
  return withLock(
    dir,
    'usage',
    () => {
      const usagePath = `${flat(dir)}/usage.jsonl`
      const cursorPath = `${flat(dir)}/usage-cursor.json`
      // the set of msgIds is loaded once: a lost cursor or a path-case mismatch can then not re-add a row
      const seen = new Set<string>()
      for (const r of readJsonl(usagePath).rows) if (typeof r.msgId === 'string') seen.add(r.msgId)
      let cursor: Obj = {}
      try {
        const c = readJson(cursorPath)
        if (isObj(c)) cursor = c
      } catch {
        cursor = {}
      }
      const old: Obj = isObj(cursor.files) ? cursor.files : {}
      const files: Obj = {}
      let estimate: { usd: number; ts: number } | undefined
      const prev = isObj(cursor.ccEstimate) ? cursor.ccEstimate : undefined
      if (prev !== undefined && typeof prev.usd === 'number') estimate = { usd: prev.usd, ts: typeof prev.ts === 'number' ? prev.ts : 0 }
      const tr = transcriptsOf(sid)
      const list: { path: string; agentId: string | null }[] = []
      if (tr.main !== null) list.push({ path: tr.main, agentId: null })
      for (const a of tr.agents) list.push({ path: a.path, agentId: agentIdOf(a.path) })
      const fresh: Obj[] = []
      let bad = 0
      let read = 0
      const take = (text: string, agentId: string | null): void => {
        for (const raw of text.split('\n')) {
          const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw
          if (l.trim() === '') continue
          let line: unknown
          try {
            line = JSON.parse(l)
          } catch {
            bad++
            continue
          }
          if (!isObj(line)) {
            bad++
            continue
          }
          if (line.type === 'cost-state' && typeof line.totalCostUSD === 'number' && Number.isFinite(line.totalCostUSD)) {
            const t = Date.parse(String(line.timestamp))
            const ts = Number.isFinite(t) ? t : 0
            if (estimate === undefined || ts >= estimate.ts) estimate = { usd: line.totalCostUSD, ts }
            continue
          }
          const row = rowOf(line, sid, agentId)
          if (row === undefined) continue
          if (row === 'bad') {
            bad++
            continue
          }
          if (seen.has(row.msgId)) continue
          seen.add(row.msgId)
          fresh.push(row)
        }
      }
      for (const t of list) {
        const key = keyOf(t.path)
        let fd: number
        try {
          fd = openSync(t.path, 'r')
        } catch {
          continue
        }
        try {
          const size = fstatSync(fd).size
          const was = isObj(old[key]) && Number.isInteger(old[key].offset) && old[key].offset >= 0 ? old[key].offset : 0
          let committed = was > size ? 0 : was // a shrunk file is read again from its start; the msgId set keeps that harmless
          let pos = committed
          let pending = Buffer.alloc(0)
          const buf = Buffer.alloc(CHUNK)
          while (pos < size) {
            const n = readSync(fd, buf, 0, CHUNK, pos)
            if (n <= 0) break
            pos += n
            pending = Buffer.concat([pending, buf.subarray(0, n)])
            const nl = pending.lastIndexOf(10)
            if (nl >= 0) {
              take(pending.subarray(0, nl + 1).toString('utf8'), t.agentId)
              committed += nl + 1
              pending = pending.subarray(nl + 1)
            }
          }
          if (committed !== was) read++
          files[key] = { offset: committed }
        } finally {
          closeSync(fd)
        }
      }
      // rows first, then the cursor: a crash between the two is repaired by the msgId set
      if (fresh.length > 0) appendFileSync(usagePath, fresh.map((r) => JSON.stringify(r)).join('\n') + '\n')
      writeJsonAtomic(cursorPath, { files, project: tr.main === null ? null : path.basename(path.dirname(tr.main)), ccEstimate: estimate ?? null })
      return { rows: fresh.length, files: read, bad, found: list.length }
    },
    opts.waitMs === undefined ? {} : { waitMs: opts.waitMs },
  )
}

/** Sweeps, and when the usage lock stays busy reads usage.jsonl as it stands (found is then counted from the transcripts). With no cursor yet no sweep has finished, so usage.jsonl is missing or partial: the result says `unswept`. */
function sweepOrRead(dir: string, repo: string, opts: SweepOpts): SweepOut {
  try {
    return sweep(dir, repo, opts)
  } catch (e) {
    if (!(e instanceof StoreBusy)) throw e
    const tr = transcriptsOf(path.basename(flat(dir)))
    const out: SweepOut = { rows: 0, files: 0, bad: 0, found: (tr.main === null ? 0 : 1) + tr.agents.length }
    if (!existsSync(`${flat(dir)}/usage-cursor.json`)) out.unswept = true
    return out
  }
}

// ==== attribution (at read time, so a meta written late is picked up) ====

const usageRows = (dir: string): Obj[] => readJsonl(`${flat(dir)}/usage.jsonl`).rows.filter((r) => typeof r.msgId === 'string')

// The plan's crew slugs, in order.
const slugsOf = (plan: Obj | null): string[] => (plan !== null && Array.isArray(plan.crews) ? plan.crews.filter(isObj).map((c: Obj) => c.slug).filter((s: unknown): s is string => typeof s === 'string') : [])
const crewWorktree = (repo: string, slug: string): string => `${flat(repo)}/.claude/worktrees/truss-${slug}`

function planOf(dir: string): Obj | null {
  try {
    const p = readJson(`${flat(dir)}/plan.json`)
    return isObj(p) && Array.isArray(p.crews) ? p : null
  } catch {
    return null
  }
}

/** Maps each row to a crew slug, `main` or `unattributed`, in the order of contract-025 section 4. */
function attributor(dir: string, repo: string, slugs: string[], platform: NodeJS.Platform): (row: Obj) => string {
  const plan = new Set(slugs)
  const norm = (p: string): string => {
    const f = flat(p).replace(/\/+$/, '')
    return platform === 'win32' ? f.toLowerCase() : f
  }
  const trees = new Map(slugs.map((s) => [norm(crewWorktree(repo, s)), s]))
  const spawns = new Map<string, string>()
  for (const e of readJsonl(`${flat(dir)}/events.jsonl`).rows) if (e.event === 'spawn' && typeof e.agentId === 'string' && typeof e.crew === 'string') spawns.set(e.agentId, e.crew)
  const tr = transcriptsOf(path.basename(flat(dir)))
  const agents = new Map(tr.agents.map((a) => [agentIdOf(a.path), a]))
  const slugOfLabel = (d: unknown): string | undefined => {
    const p = typeof d === 'string' ? parseLabel(d) : undefined
    return p !== undefined && plan.has(p.slug) ? p.slug : undefined
  }
  return (row) => {
    if (row.agentId === null || row.agentId === undefined) return MAIN
    const id = String(row.agentId)
    const a = agents.get(id)
    const meta = isObj(a?.meta) ? a.meta : undefined
    if (a !== undefined && flat(a.path).includes('/subagents/workflows/')) {
      const s = slugOfLabel(meta?.description)
      if (s !== undefined) return s
    }
    const spawned = spawns.get(id)
    if (spawned !== undefined) return spawned
    if (typeof meta?.worktreePath === 'string') {
      const s = trees.get(norm(meta.worktreePath))
      if (s !== undefined) return s
    }
    const s = slugOfLabel(meta?.description)
    return s !== undefined ? s : UNATTRIBUTED
  }
}

// ==== pricing ====

const RATES = ['inputPerMTok', 'outputPerMTok', 'cacheReadPerMTok', 'cacheWrite5mPerMTok', 'cacheWrite1hPerMTok'] as const
const ratesOk = (v: unknown): v is Record<(typeof RATES)[number], number> => isObj(v) && RATES.every((k) => typeof v[k] === 'number' && Number.isFinite(v[k]) && v[k] >= 0)

// The rates for a model: the longest pricing key that is a prefix of its id, its fast rates for a fast row; null when there are none.
function ratesFor(pricing: unknown, model: string, fast: boolean): Record<(typeof RATES)[number], number> | null {
  if (!isObj(pricing)) return null
  let best: string | undefined
  for (const k of Object.keys(pricing)) if (model.startsWith(k) && (best === undefined || k.length > best.length)) best = k
  if (best === undefined) return null
  const p = pricing[best]
  const r = fast && isObj(p) ? p.fast : p
  return ratesOk(r) ? r : null
}

// The USD of a set of rows (null when any row's model has no price, never 0), its tokens and the models with no price. `out` is priced alone: thinking is assumed to be in it.
function sumOf(rows: Obj[], pricing: unknown): { usd: number | null; tokens: number; unpriced: string[] } {
  let usd = 0
  let tokens = 0
  const unpriced = new Set<string>()
  for (const r of rows) {
    tokens += count(r.in) + count(r.out) + count(r.think) + count(r.cr) + count(r.cw5m) + count(r.cw1h) + count(r.web)
    const fast = r.speed === 'fast'
    const p = ratesFor(pricing, String(r.model), fast)
    if (p === null) {
      unpriced.add(fast ? `${r.model} (fast)` : String(r.model))
      continue
    }
    usd += (count(r.in) * p.inputPerMTok + count(r.out) * p.outputPerMTok + count(r.cr) * p.cacheReadPerMTok + count(r.cw5m) * p.cacheWrite5mPerMTok + count(r.cw1h) * p.cacheWrite1hPerMTok) / 1e6
  }
  return { usd: unpriced.size > 0 ? null : usd, tokens, unpriced: [...unpriced].sort() }
}

// ==== budgets ====

const scoped = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)
const approvedSince = (plan: Obj | null): number | undefined => {
  const t = plan !== null && typeof plan.approvedAt === 'string' ? Date.parse(plan.approvedAt) : NaN
  return Number.isFinite(t) ? t : undefined
}

/** Whether a budget holds the crew `slug` (null: the session, for queue-next) of `plan`. */
export function budgetVerdict(dir: string, repo: string, plan: Obj | null, slug: string | null): BudgetVerdict {
  const cfg = configOf(repo)
  const budget = isObj(cfg.budget) ? cfg.budget : undefined
  if (budget === undefined) return { held: false }
  const sid = path.basename(flat(dir))
  const since = approvedSince(plan)
  const entry = slug !== null && plan !== null && Array.isArray(plan.crews) ? plan.crews.find((c: unknown) => isObj(c) && c.slug === slug) : undefined
  const wt = isObj(entry) && typeof entry.workType === 'string' ? entry.workType : undefined
  const wtLimit = wt !== undefined && isObj(budget.workTypes) && isObj(budget.workTypes[wt]) ? scoped(budget.workTypes[wt].crewUsd) : undefined
  type Check = { scope: 'run' | 'crew' | 'workType' | 'session'; ref: string; base: number; label: string; rows: (all: Obj[], of: (r: Obj) => string) => Obj[] }
  const checks: Check[] = []
  const sessionUsd = scoped(budget.sessionUsd)
  if (slug === null && sessionUsd !== undefined) checks.push({ scope: 'session', ref: `budget:${sid}:session:session`, base: sessionUsd, label: 'session', rows: (all) => all })
  const runUsd = scoped(budget.runUsd)
  if (runUsd !== undefined && since !== undefined) checks.push({ scope: 'run', ref: `budget:${sid}:run:run`, base: runUsd, label: 'run', rows: (all) => all.filter((r) => Date.parse(String(r.ts)) >= since) })
  const crewUsd = scoped(budget.crewUsd)
  if (slug !== null && (crewUsd !== undefined || wtLimit !== undefined)) {
    const raises = raisesOf(repo, sid)
    const crewLimit = crewUsd === undefined ? undefined : crewUsd + raiseFor(raises, `budget:${sid}:crew:${slug}`)
    const wtLimitRaised = wtLimit === undefined ? undefined : wtLimit + raiseFor(raises, `budget:${sid}:workType:${slug}`)
    const useWt = wtLimitRaised !== undefined && (crewLimit === undefined || wtLimitRaised < crewLimit)
    const limit = (useWt ? wtLimitRaised : crewLimit) as number
    const mine = (all: Obj[], of: (r: Obj) => string): Obj[] => all.filter((r) => of(r) === slug)
    checks.push({ scope: useWt ? 'workType' : 'crew', ref: '', base: limit, label: `crew ${slug}`, rows: mine })
  }
  if (checks.length === 0) return { held: false }
  const done = sweepOrRead(dir, repo, { waitMs: 1000 })
  const all = usageRows(dir)
  const raises = raisesOf(repo, sid)
  const slugs = slugsOf(plan)
  if (slug !== null && !slugs.includes(slug)) slugs.push(slug)
  const of = attributor(dir, repo, slugs, process.platform)
  for (const c of checks) {
    const limitUsd = c.ref === '' ? c.base : c.base + raiseFor(raises, c.ref)
    if (done.found === 0) return { held: true, scope: c.scope, spentUsd: null, limitUsd, why: `budget: no transcripts found for session ${sid}, so ${c.label} spend is unknown` }
    if (done.unswept === true) return { held: true, scope: c.scope, spentUsd: null, limitUsd, why: `budget: the first usage sweep of session ${sid} is still running, so ${c.label} spend is unknown` }
    const s = sumOf(c.rows(all, of), cfg.pricing)
    if (s.usd === null) return { held: true, scope: c.scope, spentUsd: null, limitUsd, why: `budget: ${c.label} spend not priced: ${s.unpriced.join(', ')}` }
    if (s.usd >= limitUsd) return { held: true, scope: c.scope, spentUsd: s.usd, limitUsd, why: `budget: ${c.label} spent ${Math.round(s.usd * 10000) / 10000} USD, which reached the limit of ${limitUsd} USD` }
  }
  return { held: false }
}

function raisesOf(repo: string, sid: string): { ref: string; raiseUsd: number }[] {
  try {
    const r = budgetRaises(repo, sid)
    return Array.isArray(r) ? r : []
  } catch {
    return []
  }
}
const raiseFor = (raises: { ref: string; raiseUsd: number }[], ref: string): number => raises.filter((r) => r.ref === ref && typeof r.raiseUsd === 'number' && Number.isFinite(r.raiseUsd)).reduce((a, r) => a + r.raiseUsd, 0)

// ==== crew cost and the command ====

/** The crew's spend in USD, or null with the reason it can't be priced. */
export function crewCost(dir: string, repo: string, slug: string): { usd: number | null; why?: string } {
  if (sweepOrRead(dir, repo, { waitMs: 1000 }).unswept === true) return { usd: null, why: 'usage sweep still running' }
  const slugs = slugsOf(planOf(dir))
  if (!slugs.includes(slug)) slugs.push(slug)
  const of = attributor(dir, repo, slugs, process.platform)
  const rows = usageRows(dir).filter((r) => of(r) === slug)
  if (rows.length === 0) return { usd: null, why: 'not recorded' }
  const s = sumOf(rows, configOf(repo).pricing)
  return s.usd === null ? { usd: null, why: `not priced: ${s.unpriced.join(', ')}` } : { usd: s.usd }
}

function costOf(f: Flags): Obj {
  const dir = flat(need(f, 'dir'))
  const repo = flat(need(f, 'repo'))
  const only = str(f, 'crew')
  const swept = sweep(dir, repo)
  const pricing = configOf(repo).pricing
  const plan = planOf(dir)
  const slugs = slugsOf(plan)
  if (only !== undefined && !slugs.includes(only)) slugs.push(only)
  const rows = usageRows(dir)
  const of = attributor(dir, repo, slugs, process.platform)
  const since = approvedSince(plan)
  const sinceRows = since === undefined ? [] : rows.filter((r) => Date.parse(String(r.ts)) >= since)
  const run = sumOf(sinceRows, pricing)
  const session = sumOf(rows, pricing)
  const crews: Obj[] = []
  const notRecorded: string[] = []
  for (const s of slugs) {
    if (only !== undefined && s !== only) continue
    const mine = rows.filter((r) => of(r) === s)
    if (mine.length === 0) {
      notRecorded.push(s)
      crews.push({ crew: s, usd: null, why: 'not recorded', tokens: 0 })
      continue
    }
    const x = sumOf(mine, pricing)
    crews.push(x.usd === null ? { crew: s, usd: null, why: `not priced: ${x.unpriced.join(', ')}`, tokens: x.tokens } : { crew: s, usd: x.usd, tokens: x.tokens })
  }
  let estimate: number | null = null
  try {
    const c = readJson(`${dir}/usage-cursor.json`)
    if (isObj(c) && isObj(c.ccEstimate) && typeof c.ccEstimate.usd === 'number') estimate = c.ccEstimate.usd
  } catch {
    estimate = null
  }
  return {
    run: { since: since === undefined ? null : plan?.approvedAt, usd: since === undefined ? null : run.usd, tokens: run.tokens },
    session: { usd: session.usd },
    crews,
    unpriced: session.unpriced,
    notRecorded,
    claudeCodeEstimateUsd: estimate,
    sweep: swept,
  }
}

export const COST_COMMANDS: Record<string, (f: Flags) => Obj> = {
  cost: costOf,
}

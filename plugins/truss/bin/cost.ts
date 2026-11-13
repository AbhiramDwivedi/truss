// Spend, budgets and the cost command (contract-025 section 4, ADR-0038).
// The meter is a sweep of the transcripts of every session that ran the run (sessionsOf) into D/usage.jsonl under the lock D/locks/usage; attribution to a crew is resolved at read time.
// No price is written here: prices come from the client's `pricing` config. Imports node: builtins and relative paths only, and never factory.ts
// (its top-level await would make an import cycle).

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { absDirOf, budgetRaises } from './inbox.ts'
import { StoreBusy, configOf, createExclusive, flat, isObj, need, parseLabel, readJson, readJsonl, str, transcriptsOf, withLock, writeJsonAtomic } from './store.ts'
import type { Flags, Obj } from './store.ts'

export type BudgetVerdict = { held: false } | { held: true; scope: 'run' | 'crew' | 'workType' | 'session'; spentUsd: number | null; limitUsd: number; why: string; ref?: string }
export type SweepOut = { rows: number; files: number; bad: number; found: number; busy?: true }
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

// ==== the sessions of a run ====

// A run dir D is named after the session that started it. Another session that resumes the run (a second PM after a handoff) is
// recorded in D/sessions/<sid>.json when it first runs a state-changing factory command on D (ATTACH_COMMANDS, called from factory.ts
// main), so the sweep reads its transcripts too. A read (cost, inbox, decisions) never attaches: a session that only looks at a run
// keeps its spend out of the run's.
export const ATTACH_COMMANDS: readonly string[] = ['plan-args', 'plan-write', 'approve', 'start', 'admit', 'sync', 'check', 'integrate', 'mark-merged', 'finish', 'land', 'reap', 'decide', 'crew-decision', 'owns-extend']
const SID_RE = /^[A-Za-z0-9._-]+$/
const safeSid = (s: unknown): s is string => typeof s === 'string' && SID_RE.test(s) && s !== '.' && s !== '..'

/** Records session `sid` as one that ran the run in `dir`, once: D/sessions/<sid>.json is created exclusively and never rewritten.
 * The session D is named after, and a sid that is not a safe file name, are never recorded. Returns whether a record was written. */
export function recordSession(dir: string, sid: string | undefined, by: string, now: Date = new Date()): boolean {
  if (!safeSid(sid) || sid === path.basename(flat(dir)) || !existsSync(flat(dir))) return false
  const p = `${flat(dir)}/sessions/${sid}.json`
  if (existsSync(p)) return false
  mkdirSync(`${flat(dir)}/sessions`, { recursive: true })
  return createExclusive(p, { v: 1, sid, ts: now.toISOString(), by })
}

/** The sessions whose transcripts belong to the run in `dir`: the session D is named after, then each recorded one in name order. */
export function sessionsOf(dir: string): string[] {
  const own = path.basename(flat(dir))
  const out = [own]
  let names: string[]
  try {
    names = readdirSync(`${flat(dir)}/sessions`).sort()
  } catch {
    names = []
  }
  for (const n of names) {
    const s = n.endsWith('.json') ? n.slice(0, -5) : ''
    if (safeSid(s) && !out.includes(s)) out.push(s)
  }
  return out
}

/** Every transcript of every session of the run, main threads first per session; `main` is the first session's main transcript. */
function runTranscripts(dir: string): { main: string | null; list: { path: string; sid: string; agentId: string | null; meta: any }[] } {
  const list: { path: string; sid: string; agentId: string | null; meta: any }[] = []
  let main: string | null = null
  for (const [i, sid] of sessionsOf(dir).entries()) {
    const tr = transcriptsOf(sid)
    if (i === 0) main = tr.main
    if (tr.main !== null) list.push({ path: tr.main, sid, agentId: null, meta: null })
    for (const a of tr.agents) list.push({ path: a.path, sid, agentId: agentIdOf(a.path), meta: a.meta })
  }
  return { main, list }
}

const agentIdOf = (p: string): string => path.basename(p).replace(/^agent-/, '').replace(/\.jsonl$/, '')

/** Whether the file exists, is not empty and its last byte is not a newline. */
function endsTorn(p: string): boolean {
  let fd: number
  try {
    fd = openSync(p, 'r')
  } catch {
    return false
  }
  try {
    const size = fstatSync(fd).size
    if (size === 0) return false
    const b = Buffer.alloc(1)
    return readSync(fd, b, 0, 1, size - 1) === 1 && b[0] !== 10
  } finally {
    closeSync(fd)
  }
}

/** Reads every transcript of every session of the run in `dir` (sessionsOf) from its cursor and appends the new usage rows to D/usage.jsonl,
 * once per msgId; each row carries the sid of the transcript it came from. Throws StoreBusy when the lock stays busy. */
export function sweep(dir: string, repo?: string, opts: SweepOpts = {}): SweepOut {
  const platform = opts.platform ?? process.platform
  const own = path.basename(flat(dir))
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
      // Claude Code's estimate is per session (the newest cost-state line of each), and the run's is their sum. A cursor written
      // before 0.31.0 holds one ccEstimate, which is the own session's.
      const estimates = new Map<string, { usd: number; ts: number }>()
      const est = (v: unknown): { usd: number; ts: number } | undefined => (isObj(v) && typeof v.usd === 'number' ? { usd: v.usd, ts: typeof v.ts === 'number' ? v.ts : 0 } : undefined)
      if (isObj(cursor.ccEstimates)) {
        for (const [s, v] of Object.entries(cursor.ccEstimates)) {
          const e = est(v)
          if (e !== undefined) estimates.set(s, e)
        }
      } else {
        const e = est(cursor.ccEstimate)
        if (e !== undefined) estimates.set(own, e)
      }
      const tr = runTranscripts(dir)
      const list = tr.list
      const fresh: Obj[] = []
      let bad = 0
      let read = 0
      const take = (text: string, sid: string, agentId: string | null): void => {
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
            const e = estimates.get(sid)
            if (e === undefined || ts >= e.ts) estimates.set(sid, { usd: line.totalCostUSD, ts })
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
              take(pending.subarray(0, nl + 1).toString('utf8'), t.sid, t.agentId)
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
      // a torn tail (a writer died mid-row) is closed with a newline first, so the new rows start on a fresh line
      if (fresh.length > 0) appendFileSync(usagePath, (endsTorn(usagePath) ? '\n' : '') + fresh.map((r) => JSON.stringify(r)).join('\n') + '\n')
      let estimate: { usd: number; ts: number } | null = null
      for (const e of estimates.values()) estimate = estimate === null ? { ...e } : { usd: estimate.usd + e.usd, ts: Math.max(estimate.ts, e.ts) }
      writeJsonAtomic(cursorPath, { files, project: tr.main === null ? null : path.basename(path.dirname(tr.main)), ccEstimate: estimate, ccEstimates: Object.fromEntries(estimates) })
      return { rows: fresh.length, files: read, bad, found: list.length }
    },
    opts.waitMs === undefined ? {} : { waitMs: opts.waitMs },
  )
}

/** Sweeps, and when the usage lock stays busy reads usage.jsonl as it stands (found is then counted from the transcripts). The result then says `busy`, because usage.jsonl may lag (or, before a first sweep, be missing or partial). budgetVerdict reads it as it stands and accepts the lag (contract-025 section 4), but with no usage.jsonl it sweeps again and throws StoreBusy (ADR-0038 amendment 2026-11-11); crewCost returns null on any busy lock, so the append-only ledger never gets a too-low cost. */
function sweepOrRead(dir: string, repo: string, opts: SweepOpts): SweepOut {
  try {
    return sweep(dir, repo, opts)
  } catch (e) {
    if (!(e instanceof StoreBusy)) throw e
    const out: SweepOut = { rows: 0, files: 0, bad: 0, found: runTranscripts(dir).list.length }
    out.busy = true
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
  const agents = new Map(runTranscripts(dir).list.filter((a) => a.agentId !== null).map((a) => [a.agentId as string, a]))
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
// 0.29.0: a price may carry `longContext: {abovePromptTokens, <rates>}` (Claude Haiku 5.5 bills a request whose prompt is over
// 100,000 tokens at higher rates). A row is one request, and its prompt is all its input tokens: in, cache reads and both cache
// writes. A row over the threshold takes the longContext rates; a fast row never does (no model has both today).
function ratesFor(pricing: unknown, model: string, fast: boolean, prompt = 0): Record<(typeof RATES)[number], number> | null {
  if (!isObj(pricing)) return null
  let best: string | undefined
  for (const k of Object.keys(pricing)) if (model.startsWith(k) && (best === undefined || k.length > best.length)) best = k
  if (best === undefined) return null
  const p = pricing[best]
  const long = !fast && isObj(p) && isObj(p.longContext) ? p.longContext : undefined
  if (long !== undefined) {
    const above = long.abovePromptTokens
    if (typeof above !== 'number' || !Number.isFinite(above) || above < 0) return null
    if (prompt > above) return ratesOk(long) ? long : null
  }
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
    const p = ratesFor(pricing, String(r.model), fast, count(r.in) + count(r.cr) + count(r.cw5m) + count(r.cw1h))
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
  if (sessionUsd !== undefined) checks.push({ scope: 'session', ref: `budget:${sid}:session:session`, base: sessionUsd, label: 'session', rows: (all) => all })
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
  let done = sweepOrRead(dir, repo, { waitMs: 1000 })
  // busy with no usage.jsonl: the spend is unknown, so never admit. Sweep once more with the store's default wait, then let StoreBusy (exit 2, not admitted) through.
  if (done.busy === true && !existsSync(`${dir}/usage.jsonl`)) done = sweep(dir, repo, {})
  const all = usageRows(dir)
  const raises = raisesOf(repo, sid)
  const slugs = slugsOf(plan)
  if (slug !== null && !slugs.includes(slug)) slugs.push(slug)
  const of = attributor(dir, repo, slugs, process.platform)
  for (const c of checks) {
    const limitUsd = c.ref === '' ? c.base : c.base + raiseFor(raises, c.ref)
    const ref = c.scope === 'session' ? { ref: c.ref } : {}
    if (done.found === 0) return { held: true, scope: c.scope, spentUsd: null, limitUsd, why: `budget: no transcripts found for session ${sid}, so ${c.label} spend is unknown`, ...ref }
    const s = sumOf(c.rows(all, of), cfg.pricing)
    if (s.usd === null) return { held: true, scope: c.scope, spentUsd: null, limitUsd, why: `budget: ${c.label} spend not priced: ${s.unpriced.join(', ')}`, ...ref }
    if (s.usd >= limitUsd) return { held: true, scope: c.scope, spentUsd: s.usd, limitUsd, why: `budget: ${c.label} spent ${Math.round(s.usd * 10000) / 10000} USD, which reached the limit of ${limitUsd} USD`, ...ref }
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
  if (sweepOrRead(dir, repo, { waitMs: 1000 }).busy === true) return { usd: null, why: 'usage sweep busy' }
  const slugs = slugsOf(planOf(dir))
  if (!slugs.includes(slug)) slugs.push(slug)
  const of = attributor(dir, repo, slugs, process.platform)
  const rows = usageRows(dir).filter((r) => of(r) === slug)
  if (rows.length === 0) return { usd: null, why: 'not recorded' }
  const s = sumOf(rows, configOf(repo).pricing)
  return s.usd === null ? { usd: null, why: `not priced: ${s.unpriced.join(', ')}` } : { usd: s.usd }
}

function costOf(f: Flags): Obj {
  const dir = flat(absDirOf(need(f, 'dir')))
  const repo = flat(need(f, 'repo'))
  const only = str(f, 'crew')
  const swept = sweepOrRead(dir, repo, {})
  // a busy first sweep with no prior reading: the spend is unknown, never 0
  const unknown = swept.busy === true && !existsSync(`${dir}/usage.jsonl`) && !existsSync(`${dir}/usage-cursor.json`)
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
    run: { since: since === undefined ? null : plan?.approvedAt, usd: since === undefined || unknown ? null : run.usd, tokens: run.tokens },
    session: unknown ? { usd: null, why: 'usage sweep busy and no earlier reading exists' } : { usd: session.usd },
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

// The counting step of the generic retro (ADR-0051): `problems(directory)` counts where a run's wall-clock and tokens went and
// returns ranked findings. Usage: node retro/cli.ts problems <truss dir> (retro/counts.ts re-exports `problems` and `CHECKLIST`).
// Reads only structured files of the dir, never a transcript and never bin/cost.ts `crewCost` (that reads transcript metadata):
// events*.jsonl, usage.jsonl, plan.json (only whether it exists), stage-result-*.json, checks/*.json, crews/<crew>/answers.json,
// reports/** through retro/timing.ts `analyze` (unchanged), and the repo's `.claude/truss.json` `pricing` key. It writes nothing.
// `measures` is a flat object from a dotted key to a finite number counted from those files; a quantity the files cannot give has no
// key. Every number in a finding's evidence is a `measures` entry. A category the files cannot give has no finding, never a zero one.
// Ranking (ADR-0051 Decision 3): cost.wallMs descending (null last), then cost.tokens descending (null last), then id. Category never orders.
// This module covers time, quality loop, rules and gates, and cost. Code structure and tests are added by retro/problems-code.ts, which
// calls `assemble` with its own Part; that file imports this one, so its imports of this file are used only inside functions.
// Erasable TypeScript, Node built-ins only (P19). No price is written here: prices come from the client's `pricing` config.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { ratesFor } from '../bin/cost.ts'
import { analyze } from './timing.ts'
import { codePart } from './problems-code.ts'

type Json = Record<string, any>

/** The starting categories for the counting step and the judge. A starting list, never a filter (ADR-0051 Decision 1). */
export const CHECKLIST: readonly string[] = ['time', 'code structure', 'tests', 'quality loop', 'rules and gates', 'cost']

export type Cost = { wallMs: number | null; tokens: number | null; usd: number | null }
export type Target = { kind: 'plugin' | 'project-config' | 'proposed-goal'; path?: string }
export type Finding = { id: string; category: string; title: string; evidence: { measure: string; value: number }[]; cost: Cost; fix: string; target: Target }
export type Problems = { retro: 2; dir: string; measures: Record<string, number>; findings: Finding[] }
export type Part = { measures: Record<string, number>; findings: Finding[] }

const MIN = 60000
const MIN_SINK_MS = 2 * MIN // a time sink shorter than this is not a finding
const GAP_MS = 30 * MIN // no model activity this long between two usage rows is an idle gap
const RETRY_MS = 10 * MIN // a usage row this soon after a refusal is the agent's retry
const SHARE = 0.05 // a role is a cost finding when it used at least this share of all tokens
const MAX_COST_FINDINGS = 8

const readLines = (p: string): Json[] => {
  let text: string
  try { text = readFileSync(p, 'utf8') } catch { return [] }
  const out: Json[] = []
  for (const l of text.split('\n')) {
    if (!l.trim()) continue
    try { out.push(JSON.parse(l)) } catch { /* a torn last line is skipped */ }
  }
  return out
}
const readJson = (p: string): any => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const list = (p: string): string[] => { try { return readdirSync(p).sort() } catch { return [] } }
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
/** A key part: letters, digits, `_` and `-` only, so a crew, role or model never adds a dot to a dotted key. */
export const keyPart = (s: unknown): string => String(s ?? '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown'
const rowTokens = (r: Json): number => num(r.in) + num(r.out) + num(r.think) + num(r.cr) + num(r.cw5m) + num(r.cw1h) + num(r.web)

export const fmtMs = (ms: number): string => {
  const m = Math.round(ms / MIN)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const fmtTokens =(n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))

// ---------- pricing: the client's `pricing` config, never a table of ours ----------

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

// the pricing lookup is bin/cost.ts `ratesFor`, imported so the two never drift

/** USD of one usage row, or null when its model has no price (never 0). */
function rowUsd(pricing: unknown, r: Json): number | null {
  const p = ratesFor(pricing, String(r.model), r.speed === 'fast', num(r.in) + num(r.cr) + num(r.cw5m) + num(r.cw1h))
  if (p === null) return null
  return (num(r.in) * p.inputPerMTok + num(r.out) * p.outputPerMTok + num(r.cr) * p.cacheReadPerMTok + num(r.cw5m) * p.cacheWrite5mPerMTok + num(r.cw1h) * p.cacheWrite1hPerMTok) / 1e6
}

// ---------- the files ----------

type Agent = { crew: string; role: string; name: string }
export type Ctx = {
  dir: string
  /** a plan.json exists: the dir is a truss run, so a finding may target a plugin file */
  truss: boolean
  events: Json[]
  usage: Json[]
  timing: Json
  stages: Json[]
  agents: Map<string, Agent>
  /** `${crew}|${agent name}` to the agent ids that carried the name */
  byName: Map<string, string[]>
  /** usage rows by agent id (null for the main session), each list sorted by time */
  rowsOf: Map<string | null, Json[]>
  pricing: unknown
  M: Record<string, number>
}

function roleOf(e: Json): string {
  let n = String(e.agent ?? '')
  const c = String(e.crew ?? '')
  if (c && n.startsWith(`${c}-`)) n = n.slice(c.length + 1)
  n = n.replace(/-\d+$/, '')
  if (n === '') n = String(e.type ?? '').replace(/^.*:/, '')
  return keyPart(n)
}

// events.jsonl and its rolled copies events.<n>.jsonl, a copy whose text equals an earlier file's counted once
function readEvents(dir: string): Json[] {
  const seen = new Set<string>()
  const out: Json[] = []
  for (const f of list(dir).filter((x) => /^events(\.\d+)?\.jsonl$/.test(x))) {
    let text: string
    try { text = readFileSync(join(dir, f), 'utf8') } catch { continue }
    if (seen.has(text)) continue
    seen.add(text)
    for (const l of text.split('\n')) {
      if (!l.trim()) continue
      try { out.push(JSON.parse(l)) } catch { /* a torn last line is skipped */ }
    }
  }
  return out
}

function readCtx(dir: string): Ctx {
  const events = readEvents(dir)
  const usage = readLines(join(dir, 'usage.jsonl'))
  const stages: Json[] = []
  for (const f of list(dir).filter((x) => /^stage-result-.*\.json$/.test(x))) {
    const j = readJson(join(dir, f))
    for (const r of Array.isArray(j) ? j : j ? [j] : []) if (isObj(r)) stages.push(r)
  }
  const agents = new Map<string, Agent>()
  const byName = new Map<string, string[]>()
  for (const e of events) {
    if (e.event !== 'spawn' || typeof e.agentId !== 'string' || !e.crew) continue
    agents.set(e.agentId, { crew: String(e.crew), role: roleOf(e), name: String(e.agent) })
    const k = `${e.crew}|${e.agent}`
    byName.set(k, [...(byName.get(k) ?? []), e.agentId])
  }
  const rowsOf = new Map<string | null, Json[]>()
  const sorted = usage.filter((u) => !Number.isNaN(Date.parse(u.ts))).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  for (const u of sorted) {
    const id = typeof u.agentId === 'string' ? u.agentId : null
    const l = rowsOf.get(id)
    if (l) l.push(u); else rowsOf.set(id, [u])
  }
  // dir is <repo>/.git/truss/<session> when it comes from a run; the pricing config sits in that repo. A config that is absent or not
  // JSON gives no price (the retro reads the client's file but never refuses to run on it), so a cost then has tokens and no usd.
  const git = dirname(dirname(resolve(dir)))
  const repo = basename(git) === '.git' ? dirname(git) : null
  return { dir, truss: existsSync(join(dir, 'plan.json')), events, usage: sorted, timing: analyze(dir), stages, agents, byName, rowsOf, pricing: repo ? readJson(join(repo, '.claude', 'truss.json'))?.pricing : undefined, M: {} }
}

// ---------- findings ----------

/** Sets a measure when it is a positive finite number; returns its key, or null when the files gave nothing. */
export const put = (M: Record<string, number>, k: string, v: number): string | null => {
  if (!Number.isFinite(v) || v <= 0) return null
  M[k] = v
  return k
}
export const keys = (...ks: (string | null)[]): string[] => ks.filter((k): k is string => k !== null)

export function finding(M: Record<string, number>, id: string, category: string, title: string, ms: string[], cost: Cost, fix: string, target: Target): Finding | null {
  if (cost.wallMs === null && cost.tokens === null && cost.usd === null) return null
  if (ms.length === 0 || ms.some((k) => !Object.hasOwn(M, k))) return null
  return { id, category, title, evidence: ms.map((k) => ({ measure: k, value: M[k] as number })), cost, fix, target }
}

const PLUGIN = 'plugins/truss'
/** A plugin file when the dir is a truss run, else the project's own config: a plain project has no plugin file to fix. */
export const plug = (ctx: Ctx, path: string): Target => (ctx.truss ? { kind: 'plugin', path: `${PLUGIN}/${path}` } : { kind: 'project-config', path: 'CLAUDE.md' })
const cfg = (ctx: Ctx, path = ctx.truss ? '.claude/truss.json' : 'CLAUDE.md'): Target => ({ kind: 'project-config', path })

// ---------- time ----------

const GATE_TEXT = {
  owns: /^Files changed outside the crew owns/,
  slotBusy: /^heavy slot busy:/,
  allowance: /rework allowance spent/,
  admission: /^admission check failed/,
}
const API_TEXT = /API Error|authentication_failed|overloaded|rate limit|timed out/i

function timePart(ctx: Ctx): Part {
  const M = ctx.M
  const F: (Finding | null)[] = []
  const t = ctx.timing
  const stopsBy = new Map<string, Record<string, number>>()
  for (const r of ctx.stages) {
    if (r.state !== 'stopped' || typeof r.text !== 'string' || typeof r.slug !== 'string') continue
    const c = stopsBy.get(r.slug) ?? { owns: 0, slotBusy: 0, allowance: 0, admission: 0, api: 0 }
    if (GATE_TEXT.owns.test(r.text)) c.owns++
    if (GATE_TEXT.slotBusy.test(r.text)) c.slotBusy++
    if (GATE_TEXT.allowance.test(r.text)) c.allowance++
    if (GATE_TEXT.admission.test(r.text) && !API_TEXT.test(r.text)) c.admission++
    if (API_TEXT.test(r.text) && !GATE_TEXT.allowance.test(r.text)) c.api++
    stopsBy.set(r.slug, c)
  }
  for (const c of t.crews as Json[]) {
    const s = keyPart(c.slug)
    const wall = put(M, `time.wallMs.${s}`, c.wallMs)
    put(M, `time.agentWorkMs.${s}`, c.agentWorkMs)
    const rt = c.reportTotals as Json
    const st = stopsBy.get(c.slug) ?? { owns: 0, slotBusy: 0, allowance: 0, admission: 0, api: 0 }

    // slot waits: exact from every runner report of the crew
    const slot = put(M, `time.slotWaitMs.${s}`, rt.slotWaitMs)
    if (slot && rt.slotWaitMs >= MIN_SINK_MS) {
      F.push(finding(M, `P-time-slot-wait-${s}`, 'time', `Crew ${c.slug} waited ${fmtMs(rt.slotWaitMs)} for the heavy test slot over ${rt.slotRuns} runs`,
        keys(slot, put(M, `time.slotRuns.${s}`, rt.slotRuns), put(M, `rules.slotBusyStops.${s}`, st.slotBusy), wall),
        { wallMs: rt.slotWaitMs, tokens: null, usd: null },
        'Let a crew with a busy slot run its targeted tests first and take the slot only for the full suite, or raise the slot limit when the machine has room.', plug(ctx, 'bin/factory/heavy.ts')))
    }

    // test runs inside the heavy slot
    const runs = (t.heavyRuns as Json[]).filter((h) => h.crew === c.slug && h.ran)
    const test = put(M, `time.testRunMs.${s}`, c.testRunMs)
    if (test && c.testRunMs >= MIN_SINK_MS) {
      F.push(finding(M, `P-time-test-runs-${s}`, 'time', `Crew ${c.slug} spent ${fmtMs(c.testRunMs)} in test runs`,
        keys(test, put(M, `time.testRuns.${s}`, runs.length), wall),
        { wallMs: c.testRunMs, tokens: null, usd: null },
        'Shorten the test suite or run only the tests a change touches, and keep the full suite for the merge.', { kind: 'proposed-goal' }))
    }

    // QC rounds, all of them (the failed ones are the quality loop's)
    const qc = put(M, `time.qcMs.${s}`, c.qcMs)
    if (qc && c.qcMs >= MIN_SINK_MS) {
      F.push(finding(M, `P-time-qc-${s}`, 'time', `Crew ${c.slug} spent ${fmtMs(c.qcMs)} in QC rounds`,
        keys(qc, put(M, `time.qcRounds.${s}`, (c.qcRounds as Json[]).length), wall),
        { wallMs: c.qcMs, tokens: null, usd: null },
        'Ask QC to review only the change since its last round, and have the builder run the QC checklist before asking for a round.', plug(ctx, 'agents/qc-engineer.md')))
    }

    // conflict resumes
    const conflict = put(M, `time.conflictMs.${s}`, c.conflictMs)
    if (conflict && c.conflictMs >= MIN_SINK_MS) {
      F.push(finding(M, `P-time-conflict-${s}`, 'time', `Crew ${c.slug} spent ${fmtMs(c.conflictMs)} resolving merge conflicts`,
        keys(conflict, wall), { wallMs: c.conflictMs, tokens: null, usd: null },
        'Plan this crew with owns that do not overlap the crews that merge before it, or merge the shared file first.', plug(ctx, 'agents/planning-engineer.md')))
    }

    // idle inside a running period
    const idle = put(M, `time.idleMs.${s}`, c.idleMs)
    if (idle && c.idleMs >= MIN_SINK_MS) {
      F.push(finding(M, `P-time-idle-${s}`, 'time', `Crew ${c.slug} sat idle for ${fmtMs(c.idleMs)} while no agent of it was running`,
        keys(idle, wall), { wallMs: c.idleMs, tokens: null, usd: null },
        'Find what the crew waited on between members and start the next member without waiting for the project manager.', plug(ctx, 'skills/run/SKILL.md')))
    }

    // the wait between a stop and the restart; a gate caused it, or the crew asked and waited for an answer
    const wait = c.waitRulingMs + c.restartLagMs
    const gates = st.owns + st.slotBusy + st.allowance + st.admission
    if (wait >= MIN_SINK_MS) {
      const ev = keys(put(M, `time.waitRulingMs.${s}`, c.waitRulingMs), put(M, `time.restartLagMs.${s}`, c.restartLagMs), put(M, `time.stops.${s}`, c.stops),
        put(M, `rules.ownsStops.${s}`, st.owns), put(M, `rules.slotBusyStops.${s}`, st.slotBusy), put(M, `rules.allowanceStops.${s}`, st.allowance),
        put(M, `rules.admissionStops.${s}`, st.admission), put(M, `time.apiOutageStops.${s}`, st.api))
      const cost = { wallMs: wait, tokens: null, usd: null }
      const cut = [...new Set(ev)]
      if (gates > 0) {
        const parts = [st.owns && plural(st.owns, 'owns check'), st.slotBusy && `${plural(st.slotBusy, 'stop')} on a busy heavy slot`, st.allowance && `${plural(st.allowance, 'stop')} on a spent rework allowance`, st.admission && plural(st.admission, 'failed admission')].filter(Boolean)
        const fix = st.owns >= Math.max(st.slotBusy, st.allowance, st.admission)
          ? 'Plan this crew with owns wide enough for the tests and docs it must change, so the owns check does not stop it; decide the rule or the crew was wrong from the stop text.'
          : st.slotBusy >= Math.max(st.allowance, st.admission)
            ? 'Make a crew that finds the heavy slot busy keep waiting or run a smaller check, rather than stop and wait for a ruling.'
            : st.allowance >= st.admission
              ? 'Cut the QC rounds that spend the rework allowance: give the builder the QC findings in one brief and require a local green before QC.'
              : 'Check why admission failed and whether the stop needed a ruling.'
        F.push(finding(M, `P-gates-stops-${s}`, 'rules and gates', `Crew ${c.slug} lost ${fmtMs(wait)} between ${plural(c.stops, 'stop')} and restarts, and its stage results show gate stops: ${parts.join(', ')}`, cut, cost, fix, plug(ctx, 'agents/planning-engineer.md')))
      } else {
        const outage = st.api > 0
        F.push(finding(M, `P-time-stops-${s}`, 'time', `Crew ${c.slug} lost ${fmtMs(wait)} between ${plural(c.stops, 'stop')} and restarts${outage ? `, with ${plural(st.api, 'stop')} caused by an API error` : ''}`, cut, cost,
          outage ? 'Retry the step that hit the API error after a pause instead of stopping the crew.' : 'Answer a stopped crew in one batch, and let the project manager decide a call the evidence makes obvious.', plug(ctx, 'skills/run/SKILL.md')))
      }
    }
  }

  // run level: gaps with no model activity at all (waits on the client, an unattended night, a quota stop)
  let gaps = 0
  let gapMs = 0
  for (let i = 1; i < ctx.usage.length; i++) {
    const d = Date.parse(ctx.usage[i].ts) - Date.parse(ctx.usage[i - 1].ts)
    if (d > GAP_MS) { gaps++; gapMs += d }
  }
  const g = put(M, 'time.idleGapMs', gapMs)
  if (g && gapMs >= MIN_SINK_MS) {
    F.push(finding(M, 'P-time-idle-gaps', 'time', `The run had ${plural(gaps, 'gap')} of more than ${fmtMs(GAP_MS)} with no model activity, ${fmtMs(gapMs)} in all`,
      keys(g, put(M, 'time.idleGaps', gaps)), { wallMs: gapMs, tokens: null, usd: null },
      'See what each gap waited on: a client question, an unattended stretch or a quota stop. Batch the client questions and set defaults the run can take alone.', cfg(ctx)))
  }

  // run level: an API outage is a usage row from the synthetic model; the time to that agent's next row is the stall
  let outRows = 0
  let outMs = 0
  for (const rows of ctx.rowsOf.values()) {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].model !== '<synthetic>') continue
      outRows++
      const next = rows.slice(i + 1).find((r) => r.model !== '<synthetic>')
      if (next) outMs += Date.parse(next.ts) - Date.parse(rows[i].ts)
    }
  }
  const o = put(M, 'time.apiOutageMs', outMs)
  if (o && outMs >= MIN_SINK_MS) {
    F.push(finding(M, 'P-time-api-outage', 'time', `${plural(outRows, 'API outage row')} stalled agents for ${fmtMs(outMs)} until their next message`,
      keys(o, put(M, 'time.apiOutageRows', outRows)), { wallMs: outMs, tokens: null, usd: null },
      'Retry an agent after an API outage without waiting for a person.', plug(ctx, 'skills/run/SKILL.md')))
  }
  return { measures: M, findings: F.filter((f): f is Finding => f !== null) }
}

// ---------- quality loop ----------

function qualityPart(ctx: Ctx): Part {
  const M = ctx.M
  const F: (Finding | null)[] = []
  const checks = new Map<string, { n: number; fail: number }>()
  for (const f of list(join(ctx.dir, 'checks'))) {
    const m = /^(.+)-\d+\.json$/.exec(f)
    if (!m) continue
    const j = readJson(join(ctx.dir, 'checks', f))
    if (!isObj(j)) continue
    const c = checks.get(m[1]) ?? { n: 0, fail: 0 }
    c.n++
    if (j.exit !== 0) c.fail++
    checks.set(m[1], c)
  }
  const allowance = new Map<string, number>()
  for (const e of ctx.events) if (e.event === 'allowance-spent' && e.crew) allowance.set(e.crew, (allowance.get(e.crew) ?? 0) + 1)
  for (const c of ctx.timing.crews as Json[]) {
    const s = keyPart(c.slug)
    const rt = c.reportTotals as Json
    const rounds = rt.qcPass + rt.qcFail + rt.qcOther
    const failed = (c.qcRounds as Json[]).filter((q) => q.verdict === 'FAIL')
    const failMs = failed.reduce((n, q) => n + q.ms, 0)
    let failTokens = 0
    for (const q of failed) for (const id of ctx.byName.get(`${c.slug}|${q.agent}`) ?? []) for (const r of ctx.rowsOf.get(id) ?? []) failTokens += rowTokens(r)
    let rulings = 0
    for (const a of (readJson(join(ctx.dir, 'crews', String(c.slug), 'answers.json')) as Json[] | null) ?? []) if (a?.at === 'qc') rulings++
    const ck = checks.get(c.slug)
    if (rt.qcFail < 1 || (failMs <= 0 && failTokens <= 0)) continue
    const ev = keys(put(M, `quality.qcRounds.${s}`, rounds), put(M, `quality.qcFail.${s}`, rt.qcFail), put(M, `quality.qcFailMs.${s}`, failMs), put(M, `quality.qcFailTokens.${s}`, failTokens),
      put(M, `quality.checks.${s}`, ck?.n ?? 0), put(M, `quality.checkFails.${s}`, ck?.fail ?? 0), put(M, `quality.allowanceSpent.${s}`, allowance.get(c.slug) ?? 0), put(M, `quality.qcRulings.${s}`, rulings))
    const extra = [ck?.fail && `${ck.fail} of ${ck.n} check runs failed`, allowance.get(c.slug) && `the rework allowance was spent ${plural(allowance.get(c.slug) as number, 'time')}`, rulings && `${plural(rulings, 'ruling')} answered a QC finding`].filter(Boolean)
    F.push(finding(M, `P-quality-rounds-${s}`, 'quality loop', `Crew ${c.slug} ran ${plural(rounds, 'QC round')} and ${rt.qcFail} failed${extra.length ? `; ${extra.join('; ')}` : ''}`, ev,
      { wallMs: failMs > 0 ? failMs : null, tokens: failTokens > 0 ? failTokens : null, usd: null },
      rulings > 0
        ? 'A ruling answered a QC finding in this crew: read those rulings to decide whether QC was too strict or the crew wrong, and fix the QC brief or the builder brief to match.'
        : 'Put the failure causes of the failed rounds into the builder brief and have the builder run the QC checklist before QC, so a round passes the first time.',
      plug(ctx, 'agents/qc-engineer.md')))
  }
  return { measures: M, findings: F.filter((f): f is Finding => f !== null) }
}

// ---------- rules and gates: refusals ----------

function refusalTarget(ctx: Ctx, source: string, category: string): { fix: string; target: Target } {
  if (source === 'worktree-guard') return { fix: 'The guard refused a command it could not verify. If the command is legitimate, teach the guard that shape; if not, tell the crew to write it a simpler way.', target: plug(ctx, 'hooks/register.ts') }
  if (source === 'truss') return { fix: 'The rule stopped an edit the agent should not make. If the work needed the edit, route it to a builder; if the rule is wrong for this case, change the rule.', target: plug(ctx, 'hooks/register.ts') }
  if (source === 'classifier') return { fix: 'The permission classifier gave no verdict. Add an allow rule for the command shape in the project settings so it does not need a verdict.', target: cfg(ctx, '.claude/settings.json') }
  return { fix: `The project rule refused "${category}". If the call was right, widen the rule in the project settings; if the agent was wrong, say so in its brief.`, target: cfg(ctx, '.claude/settings.json') }
}

function rulesPart(ctx: Ctx): Part {
  const M = ctx.M
  const F: (Finding | null)[] = []
  type G = { n: number; retries: number; ms: number; tokens: number; source: string; category: string; at: Json[] }
  const groups = new Map<string, G>()
  for (const e of ctx.events) {
    if (e.event !== 'refusal') continue
    const source = String(e.source ?? 'unknown')
    const category = String(e.category ?? 'unknown')
    const k = `${keyPart(source)}.${keyPart(category).toLowerCase().slice(0, 48)}`
    const g = groups.get(k) ?? { n: 0, retries: 0, ms: 0, tokens: 0, source, category, at: [] }
    g.n++
    const t = Date.parse(e.ts)
    // the agent's retry: its first usage row after the refusal, when it comes within RETRY_MS
    // a refusal names its agent by agent id for a subagent, `main` for the main session, or an agent name
    const ids = e.agent === 'main' || e.agent === undefined ? [null] : ctx.agents.has(e.agent) || ctx.rowsOf.has(e.agent) ? [e.agent] : (ctx.byName.get(`${e.crew}|${e.agent}`) ?? [])
    let next: Json | undefined
    for (const id of ids) {
      const r = (ctx.rowsOf.get(id) ?? []).find((x) => Date.parse(x.ts) > t)
      if (r && (next === undefined || Date.parse(r.ts) < Date.parse(next.ts))) next = r
    }
    if (!Number.isNaN(t) && next && Date.parse(next.ts) - t <= RETRY_MS) {
      g.retries++
      g.ms += Date.parse(next.ts) - t
      g.tokens += rowTokens(next)
    }
    groups.set(k, g)
  }
  for (const [k, g] of groups) {
    const n = put(M, `rules.refusals.${k}`, g.n)
    const ms = put(M, `rules.refusalRecoveryMs.${k}`, g.ms)
    const tk = put(M, `rules.refusalRecoveryTokens.${k}`, g.tokens)
    const { fix, target } = refusalTarget(ctx, g.source, g.category)
    if (n) F.push(finding(M, `P-gates-refusals-${k}`, 'rules and gates', `${plural(g.n, 'tool call')} refused by ${g.source}: ${g.category}`,
      keys(n, put(M, `rules.refusalRetries.${k}`, g.retries), ms, tk), { wallMs: g.ms > 0 ? g.ms : null, tokens: g.tokens > 0 ? g.tokens : null, usd: null }, fix, target))
  }
  return { measures: M, findings: F.filter((f): f is Finding => f !== null) }
}

// ---------- cost ----------

// An agent with no spawn event (a direct crew's member, a hotfix agent) has no crew on record, but `bin/cost.ts` sweep stores the agent's name on
// its usage rows. The crew is the longest plan slug the name starts with (`stage-events-builder-1` is crew `stage-events`), a hotfix or fix agent
// is crew `hotfix`, and a row with no name, or a name of neither kind, stays unattributed.
const HOTFIX_NAME = /^(?:hotfix|fix)(?:-|$)/
function byRecordedName(rows: Json[], slugs: string[]): { crew: string; role: string } {
  const name = rows.map((r) => r.agent).find((n) => typeof n === 'string' && n !== '')
  if (typeof name !== 'string') return { crew: 'unattributed', role: 'unattributed' }
  const slug = slugs.filter((s) => name.startsWith(`${s}-`)).sort((x, y) => y.length - x.length)[0]
  if (slug !== undefined) return { crew: slug, role: roleOf({ crew: slug, agent: name }) }
  if (HOTFIX_NAME.test(name)) return { crew: 'hotfix', role: roleOf({ crew: 'hotfix', agent: name }) }
  return { crew: 'unattributed', role: 'unattributed' }
}

function costPart(ctx: Ctx): Part {
  const M = ctx.M
  const planned = readJson(join(ctx.dir, 'plan.json'))
  const slugs: string[] = (Array.isArray(planned?.crews) ? planned.crews : []).map((c: Json) => c?.slug).filter((s: unknown): s is string => typeof s === 'string' && s !== '')
  const F: (Finding | null)[] = []
  type Acc = { tokens: number; usd: number | null; spawns: number }
  const by = new Map<string, Acc>() // `${crew}.${role}`
  const crews = new Map<string, number>()
  const models = new Map<string, number>()
  const crewUsd = new Map<string, number | null>()
  let total = 0
  let totalUsd: number | null = 0
  for (const [id, rows] of ctx.rowsOf) {
    const a = id === null ? { crew: 'main', role: 'main' } : (ctx.agents.get(id) ?? byRecordedName(rows, slugs))
    const k = `${keyPart(a.crew)}.${a.role}`
    const acc = by.get(k) ?? { tokens: 0, usd: 0, spawns: 0 }
    for (const r of rows) {
      const tk = rowTokens(r)
      const u = rowUsd(ctx.pricing, r)
      acc.tokens += tk
      acc.usd = acc.usd === null || u === null ? null : acc.usd + u
      total += tk
      totalUsd = totalUsd === null || u === null ? null : totalUsd + u
      models.set(keyPart(r.model), (models.get(keyPart(r.model)) ?? 0) + tk)
      const c = keyPart(a.crew)
      crews.set(c, (crews.get(c) ?? 0) + tk)
      crewUsd.set(c, crewUsd.get(c) === null || u === null ? null : (crewUsd.get(c) ?? 0) + u)
    }
    by.set(k, acc)
  }
  for (const e of ctx.events) {
    if (e.event !== 'spawn' || e.by === 'factory' || !e.crew) continue
    const k = `${keyPart(e.crew)}.${roleOf(e)}`
    const acc = by.get(k) ?? { tokens: 0, usd: 0, spawns: 0 }
    acc.spawns++
    by.set(k, acc)
  }
  if (total <= 0) return { measures: M, findings: [] }
  const tot = put(M, 'cost.tokens.total', total) as string
  if (totalUsd !== null && ctx.pricing !== undefined) put(M, 'cost.usd.total', totalUsd)
  for (const [c, v] of crews) { put(M, `cost.tokens.${c}`, v); const u = crewUsd.get(c); if (u !== null && u !== undefined && ctx.pricing !== undefined) put(M, `cost.usd.${c}`, u) }
  for (const [m, v] of models) put(M, `cost.modelTokens.${m}`, v)
  for (const [k, a] of by) { put(M, `cost.tokens.${k}`, a.tokens); put(M, `cost.spawns.${k}`, a.spawns) }
  const top = [...by.entries()].filter(([, a]) => a.tokens >= total * SHARE).sort((x, y) => y[1].tokens - x[1].tokens || (x[0] < y[0] ? -1 : 1)).slice(0, MAX_COST_FINDINGS)
  for (const [k, a] of top) {
    const [crew, ...r] = k.split('.')
    const role = r.join('.')
    const usd = a.usd !== null && ctx.pricing !== undefined && a.usd > 0 ? a.usd : null
    if (usd !== null) M[`cost.usd.${k}`] = usd
    F.push(finding(M, `P-cost-role-${k}`, 'cost', `${k === 'main.main' ? 'The main session' : k === 'unattributed.unattributed' ? 'Agents with no spawn event' : `Role ${role} in crew ${crew}`} used ${fmtTokens(a.tokens)} tokens${a.spawns > 0 ? ` over ${plural(a.spawns, 'spawn')}` : ''}, of ${fmtTokens(total)} in the run`,
      keys(`cost.tokens.${k}`, a.spawns > 0 ? `cost.spawns.${k}` : null, usd !== null ? `cost.usd.${k}` : null, tot), { wallMs: null, tokens: a.tokens, usd },
      'Check whether this role needs the model it runs on and the number of spawns it takes; set a cheaper model or fewer rounds for it in the roles config.', cfg(ctx)))
  }
  // model mix: one model took most of the tokens while the run used more than one
  const ranked = [...models.entries()].sort((x, y) => y[1] - x[1])
  if (ranked.length >= 2 && ranked[0][1] * 2 > total) {
    const [m, v] = ranked[0]
    F.push(finding(M, `P-cost-model-${m}`, 'cost', `Model ${m} took ${fmtTokens(v)} of ${fmtTokens(total)} tokens, more than half of the run`,
      keys(`cost.modelTokens.${m}`, tot), { wallMs: null, tokens: v, usd: null },
      'Check which roles run on this model and move the ones that do not need it to a smaller model in the roles config.', cfg(ctx)))
  }
  return { measures: M, findings: F.filter((f): f is Finding => f !== null) }
}

// ---------- ranking and assembly ----------

const desc = (a: number | null, b: number | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a)
/** ADR-0051 Decision 3: wallMs descending (null last), then tokens descending (null last), then id. */
export const rankCmp = (a: Finding, b: Finding): number => desc(a.cost.wallMs, b.cost.wallMs) || desc(a.cost.tokens, b.cost.tokens) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Merges the parts' measures and findings, drops a finding whose evidence is not a measure, and ranks. problems-code.ts passes its own Part here. */
export function assemble(directory: string, parts: Part[]): Problems {
  const measures: Record<string, number> = {}
  for (const p of parts) Object.assign(measures, p.measures)
  const seen = new Set<string>()
  const findings: Finding[] = []
  for (const f of parts.flatMap((p) => p.findings)) {
    if (seen.has(f.id) || f.evidence.length === 0 || f.evidence.some((e) => measures[e.measure] !== e.value)) continue
    seen.add(f.id)
    findings.push(f)
  }
  findings.sort(rankCmp)
  return { retro: 2, dir: directory, measures: Object.fromEntries(Object.entries(measures).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), findings }
}

/** Counts the problems of a run dir or of a plain project dir: structured files only, ranked by measured cost. */
export function problems(directory: string): Problems {
  const ctx = readCtx(directory)
  return assemble(directory, [timePart(ctx), ...codePart(ctx), qualityPart(ctx), rulesPart(ctx), costPart(ctx)])
}

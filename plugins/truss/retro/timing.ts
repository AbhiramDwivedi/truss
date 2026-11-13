// Where a run's wall-clock went (truss 0.31.0, speed goal step 0). Usage: node retro/timing.ts <run dir D> [--json]
// Reads only structured files of D, never transcripts, so it finishes in well under a second: events.jsonl (spawn and tag events),
// usage.jsonl (one row per model message, with its agent id and real timestamp), reports/<crew>/<agent>.md (runner and QC output),
// answers/<crew>-N.json and stage-result-*.json (file mtimes), plan.json. Node built-ins and path.join only.
// A crew's wall-clock is cut into running periods (from a start to a stop) and the gaps between a stop and the next start. A gap is split at
// the ruling file's mtime into waiting for a ruling and restart lag. Inside a running period each moment is given to one category by priority:
// test run, slot wait, conflict resume, QC, other agent work, else idle. So the categories add up to the wall-clock exactly.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const USAGE_TAIL_MS = 30 * 60000 // running time this long after the last usage row has no agent data

const NOT_MEASURABLE = {
  clientWait: 'answers and stage results record no author, so a wait on the client cannot be told from a wait on the program manager; both sit in waitRuling',
  builderTests: 'tests a builder or tester runs inside its own agent are in agent work: they need the transcripts, which are not in the run dir',
  conflictQc: 'only resolver agents are tagged as conflict work; the QC rounds and re-greens a conflict caused are not marked, so they sit in QC and test runs',
  slotWaitBeyondRunners: 'a slot wait is known only from a runner report (heavy.waitedMs); a wait inside a builder is not recorded',
}

type Json = Record<string, any>
type Iv = [number, number, string]

const readLines = (p: string): Json[] => {
  if (!existsSync(p)) return []
  const out: Json[] = []
  for (const l of readFileSync(p, 'utf8').split('\n')) {
    if (!l.trim()) continue
    try { out.push(JSON.parse(l)) } catch { /* a torn last line is skipped */ }
  }
  return out
}
const readJson = (p: string): any => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const list = (p: string): string[] => { try { return readdirSync(p) } catch { return [] } }
const mtime = (p: string): number => statSync(p).mtimeMs

/** Gives each moment of [a, b) to the highest-priority interval covering it; returns ms per category (`idle` when none covers). */
function sweep(a: number, b: number, ivs: Iv[], prio: string[]): Record<string, number> {
  const out: Record<string, number> = { idle: 0 }
  for (const c of prio) out[c] = 0
  const cuts = new Set<number>([a, b])
  const clipped = ivs.map(([s, e, c]) => [Math.max(s, a), Math.min(e, b), c] as Iv).filter(([s, e]) => e > s)
  for (const [s, e] of clipped) { cuts.add(s); cuts.add(e) }
  const pts = [...cuts].sort((x, y) => x - y)
  for (let i = 0; i + 1 < pts.length; i++) {
    const [s, e] = [pts[i], pts[i + 1]]
    const here = clipped.filter(([x, y]) => x <= s && y >= e).map((v) => v[2])
    const win = prio.find((c) => here.includes(c)) ?? 'idle'
    out[win] += e - s
  }
  return out
}

/** The heavy-slot record a runner printed: `{label, waitedMs, ran?, exit?}` on the first stdout line of its report, or null. */
function heavyOf(file: string): Json | null {
  const outer = readJson(file)
  const text = typeof outer?.stdout === 'string' ? outer.stdout : existsSync(file) ? readFileSync(file, 'utf8') : ''
  for (const line of text.split('\n')) {
    if (!line.includes('"heavy"')) continue
    try { const h = JSON.parse(line)?.heavy; if (h && typeof h.waitedMs === 'number') return h } catch { /* not the JSON line */ }
  }
  return null
}

export function analyze(dir: string): Json {
  const events = readLines(join(dir, 'events.jsonl'))
  const usage = readLines(join(dir, 'usage.jsonl'))
  const agents = new Map<string, Json>()
  const factorySpawn = new Map<string, number>()
  const stopsOf = new Map<string, number[]>()
  for (const e of events) {
    const t = Date.parse(e.ts)
    if (!e.crew || e.crew === 'main' || e.crew === 'plan' || Number.isNaN(t)) continue
    if (e.event === 'spawn' && e.agentId) agents.set(e.agentId, { crew: e.crew, agent: e.agent, type: e.type })
    if (e.event === 'spawn' && e.by === 'factory' && !factorySpawn.has(e.crew)) factorySpawn.set(e.crew, t)
    if (e.event === 'tag') stopsOf.set(e.crew, [...(stopsOf.get(e.crew) ?? []), t])
  }
  const spans = new Map<string, [number, number]>()
  for (const u of usage) {
    const t = Date.parse(u.ts)
    if (!u.agentId || Number.isNaN(t)) continue
    const s = spans.get(u.agentId)
    spans.set(u.agentId, s ? [Math.min(s[0], t), Math.max(s[1], t)] : [t, t])
  }
  const lastUsage = Math.max(0, ...[...spans.values()].map((v) => v[1]))
  const slugs = [...new Set([...factorySpawn.keys(), ...stopsOf.keys(), ...[...agents.values()].map((a) => a.crew)])]
  // stage results: the end of a crew that passed, and the slot-busy stops
  const passedAt = new Map<string, number>()
  let slotStops = 0
  for (const f of list(dir).filter((x) => /^stage-result-.*\.json$/.test(x))) {
    const j = readJson(join(dir, f))
    for (const r of Array.isArray(j) ? j : j ? [j] : []) {
      if (r?.state === 'passed' && r.slug) passedAt.set(r.slug, Math.max(passedAt.get(r.slug) ?? 0, mtime(join(dir, f))))
      if (typeof r?.text === 'string' && r.text.startsWith('heavy slot busy:')) slotStops++
    }
  }
  const crews: Json[] = []
  const heavyRuns: Json[] = []
  const periodsAll: [number, number][] = []
  for (const slug of slugs) {
    const mine = [...agents.entries()].filter(([id, a]) => a.crew === slug && spans.has(id))
    const ags = mine.map(([id, a]) => ({ id, ...a, span: spans.get(id) as [number, number] }))
    const stops = (stopsOf.get(slug) ?? []).sort((x, y) => x - y)
    const firstUse = ags.length ? Math.min(...ags.map((a) => a.span[0])) : Infinity
    const S = factorySpawn.get(slug) ?? firstUse
    const E = Math.max(S, ...stops, passedAt.get(slug) ?? 0, ...ags.map((a) => a.span[1]))
    if (!Number.isFinite(S)) continue
    const rulings = list(join(dir, 'answers')).filter((f) => f.startsWith(`${slug}-`) && /-\d+\.json$/.test(f) && f.slice(slug.length + 1).match(/^\d+\.json$/))
    const ruleAt = rulings.map((f) => ({ t: mtime(join(dir, 'answers', f)), at: (readJson(join(dir, 'answers', f)) ?? [])[0]?.at }))
    const cat = { agentWorkMs: 0, heavyWaitMs: 0, testRunMs: 0, qcMs: 0, conflictMs: 0, waitRulingMs: 0, restartLagMs: 0, idleMs: 0, noUsageMs: 0 }
    const qcRounds: Json[] = []
    const ivs: Iv[] = []
    for (const a of ags) {
      const [s, e] = a.span
      const name = String(a.agent)
      if (/-qc(-\d+)?$/.test(name)) {
        ivs.push([s, e, 'qc'])
        const v = existsSync(join(dir, 'reports', slug, `${name}.md`)) ? /VERDICT:\s*(\w+)/.exec(readFileSync(join(dir, 'reports', slug, `${name}.md`), 'utf8'))?.[1] ?? null : null
        qcRounds.push({ agent: name, verdict: v, ms: e - s, startTs: new Date(s).toISOString() })
      } else if (/-resolver(-\d+)?$/.test(name)) ivs.push([s, e, 'conflict'])
      else {
        const h = /-runner(-\d+)?$/.test(name) ? heavyOf(join(dir, 'reports', slug, `${name}.md`)) : null
        if (h) {
          const w = Math.min(h.waitedMs, e - s)
          ivs.push([s, s + w, 'heavyWait'])
          if (h.ran !== false) ivs.push([s + w, e, 'testRun'])
          heavyRuns.push({ crew: slug, agent: name, label: h.label, waitedMs: w, runMs: h.ran === false ? 0 : e - s - w, ran: h.ran !== false })
        } else ivs.push([s, e, 'work'])
      }
    }
    qcRounds.sort((x, y) => (x.startTs < y.startTs ? -1 : 1))
    const add = (r: Record<string, number>) => {
      cat.agentWorkMs += r.work; cat.heavyWaitMs += r.heavyWait; cat.testRunMs += r.testRun; cat.qcMs += r.qc; cat.conflictMs += r.conflict; cat.idleMs += r.idle; cat.noUsageMs += r.noUsage
    }
    ivs.push([lastUsage + USAGE_TAIL_MS, Infinity, 'noUsage'])
    const prio = ['testRun', 'heavyWait', 'conflict', 'qc', 'work', 'noUsage']
    let start = S
    for (let i = 0; i < stops.length; i++) {
      const stop = stops[i]
      const limit = stops[i + 1] ?? E
      if (stop > start) { add(sweep(start, stop, ivs, prio)); periodsAll.push([start, stop]) }
      const next = ags.map((a) => a.span[0]).filter((t) => t > stop && t < limit).sort((x, y) => x - y)[0] ?? null
      const rule = ruleAt.map((r) => r.t).filter((t) => t >= stop && t <= (next ?? limit)).sort((x, y) => x - y)[0] ?? null
      if (next === null) {
        // no agent data shows when the crew restarted: the time after the ruling cannot be split into restart lag and work
        cat.waitRulingMs += (rule ?? stop) - stop
        cat.noUsageMs += limit - (rule ?? stop)
        if (limit > (rule ?? stop)) periodsAll.push([rule ?? stop, limit])
        start = Math.max(limit, stop)
      } else {
        cat.waitRulingMs += (rule ?? next) - stop
        cat.restartLagMs += next - (rule ?? next)
        start = next
      }
    }
    if (E > start) { add(sweep(start, E, ivs, prio)); periodsAll.push([start, E]) }
    const afterQcRuling = ruleAt.filter((r) => r.at === 'qc').map((r) => qcRounds.find((q) => Date.parse(q.startTs) > r.t)).filter(Boolean)
      .map((q) => ({ agent: q.agent, verdict: q.verdict, ms: q.ms }))
    // exact figures from every report of the crew, with or without usage rows (no timestamps needed)
    const rt = { runnerReports: 0, slotRuns: 0, slotWaitMs: 0, slotGaveUp: 0, qcPass: 0, qcFail: 0, qcOther: 0 }
    for (const f of list(join(dir, 'reports', slug))) {
      const file = join(dir, 'reports', slug, f)
      if (/-runner(-\d+)?\.md$/.test(f)) {
        rt.runnerReports++
        const h = heavyOf(file)
        if (h) { rt.slotRuns++; rt.slotWaitMs += h.waitedMs; if (h.ran === false) rt.slotGaveUp++ }
      } else if (/-qc(-\d+)?\.md$/.test(f)) {
        const v = /VERDICT:\s*(\w+)/.exec(readFileSync(file, 'utf8'))?.[1]
        if (v === 'PASS') rt.qcPass++; else if (v === 'FAIL') rt.qcFail++; else rt.qcOther++
      }
    }
    crews.push({ slug, startTs: new Date(S).toISOString(), endTs: new Date(E).toISOString(), wallMs: E - S, ...cat, clientWaitMs: null, stops: stops.length, reportTotals: rt, qcRounds, afterQcRuling })
  }
  crews.sort((a, b) => (a.startTs < b.startTs ? -1 : 1))
  // agents with a usage span but no spawn event: their work cannot be put on a crew
  let unAgents = 0
  let unMs = 0
  for (const [id, [s, e]] of spans) if (!agents.has(id)) { unAgents++; unMs += e - s }
  const plan = readJson(join(dir, 'plan.json'))
  const planStart = plan?.approvedAt ? Date.parse(plan.approvedAt) : NaN
  const first = Math.min(...crews.map((c) => Date.parse(c.startTs)))
  const runStart = Number.isFinite(planStart) && planStart <= first ? planStart : first
  const runEnd = Math.max(...crews.map((c) => Date.parse(c.endTs)))
  const idleRun = sweep(runStart, runEnd, periodsAll.map(([a, b]) => [a, b, 'run'] as Iv), ['run'])
  const sum = (k: string) => crews.reduce((n, c) => n + c[k], 0)
  const sum2 = (k: string) => crews.reduce((n, c) => n + c.reportTotals[k], 0)
  const runs = heavyRuns.filter((h) => h.ran).map((h) => h.runMs).sort((a, b) => a - b)
  const all = crews.flatMap((c) => c.qcRounds)
  return {
    dir,
    run: {
      startTs: crews.length ? new Date(runStart).toISOString() : null, endTs: crews.length ? new Date(runEnd).toISOString() : null,
      wallMs: crews.length ? runEnd - runStart : 0, crewMs: sum('wallMs'), stops: sum('stops'), noCrewRunningMs: idleRun.idle,
      unattributedAgents: unAgents, unattributedMs: unMs, slotBusyStops: slotStops,
      totals: Object.fromEntries(['agentWorkMs', 'heavyWaitMs', 'testRunMs', 'qcMs', 'conflictMs', 'waitRulingMs', 'restartLagMs', 'idleMs', 'noUsageMs'].map((k) => [k, sum(k)])),
      reportTotals: Object.fromEntries(Object.keys(crews[0]?.reportTotals ?? {}).map((k) => [k, sum2(k)])),
      qcRounds: all.length, qcFail: all.filter((q) => q.verdict === 'FAIL').length, qcFailMs: all.filter((q) => q.verdict === 'FAIL').reduce((n, q) => n + q.ms, 0),
      heavyRuns: { n: heavyRuns.length, ran: runs.length, medianRunMs: runs.length ? runs[Math.floor(runs.length / 2)] : null, maxRunMs: runs.length ? runs[runs.length - 1] : null, neverRan: heavyRuns.length - runs.length },
    },
    crews,
    heavyRuns,
    notMeasurable: NOT_MEASURABLE,
  }
}

const dur = (ms: number | null): string => {
  if (ms === null) return 'not measurable'
  const m = Math.round(ms / 60000)
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

export function render(r: Json): string {
  const head = '| Crew | Wall | Test runs | Slot waits | QC | Conflict | Agent work | Waiting for ruling | Restart lag | Idle | No data | Client wait | Stops |'
  const rows = r.crews.map((c: Json) => `| ${c.slug} | ${dur(c.wallMs)} | ${dur(c.testRunMs)} | ${dur(c.heavyWaitMs)} | ${dur(c.qcMs)} | ${dur(c.conflictMs)} | ${dur(c.agentWorkMs)} | ${dur(c.waitRulingMs)} | ${dur(c.restartLagMs)} | ${dur(c.idleMs)} | ${dur(c.noUsageMs)} | ${dur(c.clientWaitMs)} | ${c.stops} |`)
  const t = r.run.totals
  const tot = `| all crews (crew-time) | ${dur(r.run.crewMs)} | ${dur(t.testRunMs)} | ${dur(t.heavyWaitMs)} | ${dur(t.qcMs)} | ${dur(t.conflictMs)} | ${dur(t.agentWorkMs)} | ${dur(t.waitRulingMs)} | ${dur(t.restartLagMs)} | ${dur(t.idleMs)} | ${dur(t.noUsageMs)} | not measurable | ${r.run.stops} |`
  const h = r.run.heavyRuns
  const out = [head, head.replace(/[^|]+/g, '---'), ...rows, tot, '',
    `Run wall-clock: ${dur(r.run.wallMs)} (${r.run.startTs} to ${r.run.endTs}); no crew was running for ${dur(r.run.noCrewRunningMs)} of it (a stop with no restart evidence counts as running, so this is a floor).`,
    `Heavy-slot runs: ${h.n} (${h.ran} ran, ${h.neverRan} gave up waiting); median test run ${dur(h.medianRunMs)}, longest ${dur(h.maxRunMs)}; ${r.run.slotBusyStops} stops were "heavy slot busy".`,
    `All reports, in or out of the usage window: ${r.run.reportTotals.slotRuns} slot runs waited ${dur(r.run.reportTotals.slotWaitMs)} in all (${r.run.reportTotals.slotGaveUp} gave up); QC verdicts ${r.run.reportTotals.qcPass} PASS, ${r.run.reportTotals.qcFail} FAIL.`,
    `QC rounds (usage window): ${r.run.qcRounds}, of which ${r.run.qcFail} FAILed, ${dur(r.run.qcFailMs)} in total.`,
    `Agents with usage but no spawn event (not on any crew): ${r.run.unattributedAgents}, ${dur(r.run.unattributedMs)} of agent time.`, '',
    ...Object.entries(r.notMeasurable).map(([k, v]) => `- ${k}: not measurable, ${v}.`)]
  return out.join('\n') + '\n'
}

if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2)
  const dir = args.find((a) => !a.startsWith('--'))
  if (!dir || !existsSync(dir)) { console.error('usage: node timing.ts <run dir> [--json]'); process.exit(2) }
  const r = analyze(dir)
  process.stdout.write(args.includes('--json') ? JSON.stringify(r, null, 2) + '\n' : render(r))
}

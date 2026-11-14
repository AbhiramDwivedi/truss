// Where a run's wall-clock went (truss 0.31.0, speed goal step 0). Usage: node retro/timing.ts <run dir D> [--json]
// Reads only structured files of D, never transcripts, so it finishes in well under a second: events.jsonl (spawn and tag events),
// usage.jsonl (one row per model message, with its agent id and real timestamp), reports/<crew>/<agent>.md (runner and QC output),
// answers/<crew>-N.json and stage-result-*.json (file mtimes), plan.json. Node built-ins and path.join only.
// A crew's wall-clock is cut into running periods (from a start to a stop) and the gaps between a stop and the next start. A gap is split at
// the ruling file's mtime into waiting for a ruling and restart lag. Inside a running period each moment is given to one category by priority:
// test run, slot wait, conflict resume, QC, other agent work, else idle. So the categories add up to the wall-clock exactly.
// Batch stamping: a stage workflow writes the spawn and tag events of the whole stage in one burst when it ends, so those timestamps are the
// workflow's end, not the moment of each event. So a period is never bounded by an event stamp, whether or not a batch is detected: it starts at
// the first usage row of the crew's first agent and, for each stop, ends at the last usage row of the agents started before that stop. Event
// stamps only order and assign the stops. The time from that last usage row to the stop stamp is stampLagMs ("stop-stamp lag (not crew time)"),
// never idle; the time from the factory spawn to the first usage row is startLeadMs, outside the split. A crew with no usage rows falls back to
// its event stamps. Detection (`batchOf`) only flags crews in the output: leave out the factory's own spawn events (they are real-time), sort the
// other spawn and tag events of crews by timestamp, split them where two neighbours are more than BATCH_GAP_MS apart, and call a group of at least
// BATCH_MIN events a batch. Heavy runner reports (0.32.0 background jobs): a finished report's heavy.waitedMs is slot wait and the rest of
// the runner's span is test run; a `ran: false` report is all slot wait; a `pending: true` report's waitedMs is the call waiting for a job
// that was queued or running, so the whole span is test run and none is slot wait (`slotWaitOf`). Coverage: run.usage gives the time range of usage.jsonl and the spawned agents that have no usage row; an agent without
// rows is never counted as zero time, and time after the last usage row is `noUsage`.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const BATCH_GAP_MS = 2000 // neighbours closer than this belong to one burst
const BATCH_MIN = 3 // fewer events than this in a burst are taken as real-time
const USAGE_TAIL_MS = 30 * 60000 // running time this long after the last usage row has no agent data

const NOT_MEASURABLE = {
  clientWait: 'answers and stage results record no author, so a wait on the client cannot be told from a wait on the program manager; both sit in waitRuling',
  builderTests: 'tests a builder or tester runs inside its own agent are in agent work: they need the transcripts, which are not in the run dir',
  conflictQc: 'only resolver agents are tagged as conflict work; the QC rounds and re-greens a conflict caused are not marked, so they sit in QC and test runs',
  slotWaitBeyondRunners: 'a slot wait is known only from a runner report (heavy.waitedMs of a finished or gave-up job; the queue time of a pending job is not told from its run time and counts as test run); a wait inside a builder is not recorded',
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

/**
 * Ms of a runner's heavy record that were a wait for a heavy slot. `waitedMs` means different things by shape (bin/factory/heavy.ts):
 * a finished job (foreground, or a background job collected on a later call) carries the job's own slot wait; a gave-up job (`ran: false`)
 * carries the whole wait; a pending job (`pending: true`) carries how long this call waited for the job, which is queue time and run time
 * together and not told apart in the report, so it is counted as test run (0 here).
 */
const slotWaitOf = (h: Json): number => (h.pending === true ? 0 : h.waitedMs)

/** The events (by index in `events`) that sit in a batch-stamped burst; see the header for the rule. */
function batchOf(events: Json[]): Set<number> {
  const ix = events.map((e, i) => [Date.parse(e.ts), i] as [number, number])
    .filter(([t, i]) => !Number.isNaN(t) && (events[i].event === 'spawn' || events[i].event === 'tag') && events[i].by !== 'factory' && events[i].crew && events[i].crew !== 'main' && events[i].crew !== 'plan')
    .sort((x, y) => x[0] - y[0] || x[1] - y[1])
  const out = new Set<number>()
  let group: number[] = []
  const flush = () => { if (group.length >= BATCH_MIN) for (const i of group) out.add(i); group = [] }
  let prev = -Infinity
  for (const [t, i] of ix) { if (t - prev > BATCH_GAP_MS) flush(); group.push(i); prev = t }
  flush()
  return out
}

export function analyze(dir: string): Json {
  const events = readLines(join(dir, 'events.jsonl'))
  const usage = readLines(join(dir, 'usage.jsonl'))
  const agents = new Map<string, Json>()
  const factorySpawn = new Map<string, number>()
  const stopsOf = new Map<string, number[]>()
  const batched = batchOf(events)
  const batchTags = new Map<string, Set<number>>()
  const batchSpawns = new Map<string, number>()
  for (const [i, e] of events.entries()) {
    const t = Date.parse(e.ts)
    if (!e.crew || e.crew === 'main' || e.crew === 'plan' || Number.isNaN(t)) continue
    if (e.event === 'spawn' && e.agentId) agents.set(e.agentId, { crew: e.crew, agent: e.agent, type: e.type })
    if (e.event === 'spawn' && e.by === 'factory' && !factorySpawn.has(e.crew)) factorySpawn.set(e.crew, t)
    if (e.event === 'tag') stopsOf.set(e.crew, [...(stopsOf.get(e.crew) ?? []), t])
    if (e.event === 'tag' && batched.has(i)) batchTags.set(e.crew, (batchTags.get(e.crew) ?? new Set()).add(t))
    if (e.event === 'spawn' && batched.has(i)) batchSpawns.set(e.crew, (batchSpawns.get(e.crew) ?? 0) + 1)
  }
  const spans = new Map<string, [number, number]>()
  for (const u of usage) {
    const t = Date.parse(u.ts)
    if (!u.agentId || Number.isNaN(t)) continue
    const s = spans.get(u.agentId)
    spans.set(u.agentId, s ? [Math.min(s[0], t), Math.max(s[1], t)] : [t, t])
  }
  const lastUsage = Math.max(0, ...[...spans.values()].map((v) => v[1]))
  const sessions = new Map<string, { rows: number; first: number; last: number }>()
  for (const u of usage) {
    const t = Date.parse(u.ts)
    if (Number.isNaN(t)) continue
    const k = String(u.sid ?? 'unknown')
    const c = sessions.get(k)
    sessions.set(k, c ? { rows: c.rows + 1, first: Math.min(c.first, t), last: Math.max(c.last, t) } : { rows: 1, first: t, last: t })
  }
  const bySession = [...sessions.entries()].map(([sid, v]) => ({ sid, rows: v.rows, firstTs: new Date(v.first).toISOString(), lastTs: new Date(v.last).toISOString(), first: v.first, last: v.last })).sort((a, b) => a.first - b.first)
  // time between one PM session's last usage row and the next session's first is "no PM session running": not crew idle, not missing data
  const noSession: Iv[] = []
  for (let i = 0, reach = -Infinity; i < bySession.length; i++) {
    if (i > 0 && bySession[i].first - reach > USAGE_TAIL_MS) noSession.push([reach, bySession[i].first, 'noSession'])
    reach = Math.max(reach, bySession[i].last)
  }
  const firstUsageTs = spans.size ? Math.min(...[...spans.values()].map((v) => v[0])) : null
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
    const S = Number.isFinite(firstUse) ? firstUse : factorySpawn.get(slug) ?? Infinity
    const E = Math.max(S, ...stops, passedAt.get(slug) ?? 0, ...ags.map((a) => a.span[1]))
    if (!Number.isFinite(S)) continue
    const rulings = list(join(dir, 'answers')).filter((f) => f.startsWith(`${slug}-`) && /-\d+\.json$/.test(f) && f.slice(slug.length + 1).match(/^\d+\.json$/))
    const ruleAt = rulings.map((f) => ({ t: mtime(join(dir, 'answers', f)), at: (readJson(join(dir, 'answers', f)) ?? [])[0]?.at }))
    const cat = { agentWorkMs: 0, heavyWaitMs: 0, testRunMs: 0, qcMs: 0, conflictMs: 0, waitRulingMs: 0, restartLagMs: 0, idleMs: 0, noUsageMs: 0, stampLagMs: 0, noSessionMs: 0 }
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
          const w = Math.min(slotWaitOf(h), e - s)
          ivs.push([s, s + w, 'heavyWait'])
          if (h.ran !== false) ivs.push([s + w, e, 'testRun'])
          heavyRuns.push({ crew: slug, agent: name, label: h.label, waitedMs: w, runMs: h.ran === false ? 0 : e - s - w, ran: h.ran !== false })
        } else ivs.push([s, e, 'work'])
      }
    }
    qcRounds.sort((x, y) => (x.startTs < y.startTs ? -1 : 1))
    const add = (r: Record<string, number>) => {
      cat.agentWorkMs += r.work; cat.heavyWaitMs += r.heavyWait; cat.testRunMs += r.testRun; cat.qcMs += r.qc; cat.conflictMs += r.conflict; cat.idleMs += r.idle; cat.noUsageMs += r.noUsage; cat.noSessionMs += r.noSession
    }
    ivs.push([lastUsage + USAGE_TAIL_MS, Infinity, 'noUsage'], ...noSession)
    const prio = ['testRun', 'heavyWait', 'conflict', 'qc', 'work', 'noSession', 'noUsage']
    // the part of a gap that lies between two PM sessions goes to noSessionMs, not to the gap's own category
    const span = (a: number, b: number): number => {
      if (b <= a) return 0
      const ov = noSession.reduce((n, [x, y]) => n + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0)
      cat.noSessionMs += ov
      return b - a - ov
    }
    let start = S
    for (let i = 0; i < stops.length; i++) {
      const stop = stops[i]
      const limit = stops[i + 1] ?? E
      // the period ends at the last agent activity before the stop stamp; the tail up to the stamp is stop-stamp lag, not idle
      let end = stop
      {
        const lastAct = Math.max(-Infinity, ...ags.filter((a) => a.span[0] < stop && a.span[1] > start).map((a) => a.span[1]))
        if (Number.isFinite(lastAct) && lastAct < stop) { end = lastAct; cat.stampLagMs += stop - lastAct }
      }
      if (end > start) { add(sweep(start, end, ivs, prio)); periodsAll.push([start, end]) }
      const next = ags.map((a) => a.span[0]).filter((t) => t > stop && t < limit).sort((x, y) => x - y)[0] ?? null
      const rule = ruleAt.map((r) => r.t).filter((t) => t >= stop && t <= (next ?? limit)).sort((x, y) => x - y)[0] ?? null
      if (next === null) {
        // no agent data shows when the crew restarted: the time after the ruling cannot be split into restart lag and work
        cat.waitRulingMs += span(stop, rule ?? stop)
        cat.noUsageMs += span(rule ?? stop, limit)
        if (limit > (rule ?? stop)) periodsAll.push([rule ?? stop, limit])
        start = Math.max(limit, stop)
      } else {
        cat.waitRulingMs += span(stop, rule ?? next)
        cat.restartLagMs += span(rule ?? next, next)
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
        if (h) { rt.slotRuns++; rt.slotWaitMs += slotWaitOf(h); if (h.ran === false) rt.slotGaveUp++ }
      } else if (/-qc(-\d+)?\.md$/.test(f)) {
        const v = /VERDICT:\s*(\w+)/.exec(readFileSync(file, 'utf8'))?.[1]
        if (v === 'PASS') rt.qcPass++; else if (v === 'FAIL') rt.qcFail++; else rt.qcOther++
      }
    }
    crews.push({ slug, startTs: new Date(S).toISOString(), endTs: new Date(E).toISOString(), wallMs: E - S, ...cat, clientWaitMs: null, stops: stops.length, startLeadMs: factorySpawn.has(slug) && Number.isFinite(firstUse) ? firstUse - (factorySpawn.get(slug) as number) : null, noUsageAgents: [...agents.entries()].filter(([id, a]) => a.crew === slug && !spans.has(id)).map(([, a]) => a.agent), batchStamped: { tags: batchTags.get(slug)?.size ?? 0, spawns: batchSpawns.get(slug) ?? 0 }, reportTotals: rt, qcRounds, afterQcRuling })
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
      batchStampedCrews: crews.filter((c) => c.batchStamped.tags || c.batchStamped.spawns).map((c) => c.slug),
      usage: { rows: usage.length, firstTs: firstUsageTs === null ? null : new Date(firstUsageTs).toISOString(), lastTs: spans.size ? new Date(lastUsage).toISOString() : null,
        sessions: bySession.map(({ first, last, ...v }) => v), agentsWithoutRows: [...agents.entries()].filter(([id]) => !spans.has(id)).map(([id, a]) => ({ id, crew: a.crew, agent: a.agent })) },
      unattributedAgents: unAgents, unattributedMs: unMs, slotBusyStops: slotStops,
      totals: Object.fromEntries(['agentWorkMs', 'heavyWaitMs', 'testRunMs', 'qcMs', 'conflictMs', 'waitRulingMs', 'restartLagMs', 'idleMs', 'noUsageMs', 'stampLagMs', 'noSessionMs'].map((k) => [k, sum(k)])),
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
  const head = '| Crew | Wall | Test runs | Slot waits | QC | Conflict | Agent work | Waiting for ruling | Restart lag | Idle | No data | Stop-stamp lag (not crew time) | No PM session | Client wait | Stops |'
  const rows = r.crews.map((c: Json) => `| ${c.slug} | ${dur(c.wallMs)} | ${dur(c.testRunMs)} | ${dur(c.heavyWaitMs)} | ${dur(c.qcMs)} | ${dur(c.conflictMs)} | ${dur(c.agentWorkMs)} | ${dur(c.waitRulingMs)} | ${dur(c.restartLagMs)} | ${dur(c.idleMs)} | ${dur(c.noUsageMs)} | ${dur(c.stampLagMs)} | ${dur(c.noSessionMs)} | ${dur(c.clientWaitMs)} | ${c.stops} |`)
  const t = r.run.totals
  const tot = `| all crews (crew-time) | ${dur(r.run.crewMs)} | ${dur(t.testRunMs)} | ${dur(t.heavyWaitMs)} | ${dur(t.qcMs)} | ${dur(t.conflictMs)} | ${dur(t.agentWorkMs)} | ${dur(t.waitRulingMs)} | ${dur(t.restartLagMs)} | ${dur(t.idleMs)} | ${dur(t.noUsageMs)} | ${dur(t.stampLagMs)} | ${dur(t.noSessionMs)} | not measurable | ${r.run.stops} |`
  const h = r.run.heavyRuns
  const out = [head, head.replace(/[^|]+/g, '---'), ...rows, tot, '',
    `Run wall-clock: ${dur(r.run.wallMs)} (${r.run.startTs} to ${r.run.endTs}); no crew was running for ${dur(r.run.noCrewRunningMs)} of it (a stop with no restart evidence counts as running, so this is a floor).`,
    `Heavy-slot runs: ${h.n} (${h.ran} ran, ${h.neverRan} gave up waiting); median test run ${dur(h.medianRunMs)}, longest ${dur(h.maxRunMs)}; ${r.run.slotBusyStops} stops were "heavy slot busy".`,
    `All reports, in or out of the usage window: ${r.run.reportTotals.slotRuns} slot runs waited ${dur(r.run.reportTotals.slotWaitMs)} in all (${r.run.reportTotals.slotGaveUp} gave up); QC verdicts ${r.run.reportTotals.qcPass} PASS, ${r.run.reportTotals.qcFail} FAIL.`,
    `QC rounds (usage window): ${r.run.qcRounds}, of which ${r.run.qcFail} FAILed, ${dur(r.run.qcFailMs)} in total.`,
    `Batch-stamped events (a stage workflow wrote them in one burst at its end): ${r.run.batchStampedCrews.length ? r.crews.filter((c: Json) => c.batchStamped.tags || c.batchStamped.spawns).map((c: Json) => `${c.slug} (${c.batchStamped.tags} tag, ${c.batchStamped.spawns} spawn)`).join(', ') : 'none'}. Tail after the last agent activity of a batch-stamped stop is stop-stamp lag, not idle.`,
    `Usage coverage: ${r.run.usage.rows} rows from ${r.run.usage.firstTs} to ${r.run.usage.lastTs}; ${r.run.usage.agentsWithoutRows.length} spawned agents have no usage rows (not counted as zero, not measured: ${[...new Set(r.run.usage.agentsWithoutRows.map((a: Json) => a.crew))].join(', ') || 'none'}). Time after the last row is in "No data"; time between PM sessions is in "No PM session" (not crew idle).`,
    ...r.run.usage.sessions.map((x: Json) => `Usage of session ${x.sid}: ${x.rows} rows from ${x.firstTs} to ${x.lastTs}.`),
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

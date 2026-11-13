// The finish audit: recording a run's agents, restarts and escalations, and the session audit. Moved unchanged from
// bin/factory.ts (0.31.0 item 5). Never imports factory.ts, whose top-level await would make an import cycle.
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { isObj, parseLabel } from '../store.ts'
import type { Obj } from '../store.ts'
import { family, markerOf, qcFails, qcK, runStart } from '../../hooks/register.ts'
import { countedQc, jsonLines, newestMtime, promptTask, reportsOf, runsOf, STALE_MS, SYNTHETIC_MODEL, transcriptFacts } from './runs.ts'
import type { RunAgent, WfRun } from './runs.ts'
import { appendDecision, appendEvent, intOr, roleDefaults, run } from './shared.ts'

export type Audit = { label: string; why: string; slug?: string }

const textOfResult = (r: unknown): string | undefined => {
  if (typeof r === 'string') return r
  if (isObj(r) && typeof r.report === 'string') return r.report
  return r === undefined ? undefined : JSON.stringify(r)
}

// Pure role audit: qc must be truss:qc-engineer and never use Write or Edit; stress must be truss:stress-engineer or truss:qc-engineer. Returns the reason, or undefined when the agent is fine.
export function roleAudit(role: string, agentType: string | undefined, toolNames: readonly string[], roles?: Obj): string | undefined {
  // ADR-0022 R4: ux is audited like qc, against the run's ux row agentType (truss:ux-engineer, or what truss.json roles.ux maps)
  if (role === 'ux') {
    const want = isObj(roles?.ux) && typeof roles.ux.agentType === 'string' ? roles.ux.agentType : 'truss:ux-engineer'
    if (agentType !== want) return `ux ran as ${agentType ?? 'an unknown type'}, not ${want}`
    if (toolNames.some((t) => t === 'Write' || t === 'Edit')) return 'a UX engineer used Write or Edit'
  }
  if (role === 'qc') {
    if (agentType !== 'truss:qc-engineer') return `qc ran as ${agentType ?? 'an unknown type'}, not truss:qc-engineer`
    if (toolNames.some((t) => t === 'Write' || t === 'Edit')) return 'a QC used Write or Edit'
  }
  if (role === 'stress' && agentType !== 'truss:stress-engineer' && agentType !== 'truss:qc-engineer') return `stress ran as ${agentType ?? 'an unknown type'}, not truss:stress-engineer or truss:qc-engineer`
  return undefined
}

// Record step: files each crew agent's result under reports/, appends spawn and report lines (once), and audits every agent of the run.
export function recordRun(dir: string, wfRun: WfRun, crewSlugs: Set<string>, roles: Obj, passed?: Audit[]): Audit[] {
  const audits: Audit[] = []
  const events = existsSync(`${dir}/events.jsonl`) ? jsonLines(`${dir}/events.jsonl`) : []
  for (const a of wfRun.agents) {
    const parsed = parseLabel(a.label)
    const facts = transcriptFacts(a.transcript)
    const agentType = typeof a.meta?.agentType === 'string' ? a.meta.agentType : undefined
    const slug = parsed !== undefined && crewSlugs.has(parsed.slug) ? parsed.slug : undefined
    const bad = (why: string): void => void audits.push({ label: a.label, why, ...(slug !== undefined ? { slug } : {}) })
    if (a.meta === undefined || typeof a.meta.model !== 'string' || a.meta.model === '') bad('the meta file has no model')
    const fam = family(facts.model)
    if (facts.synthetic) passed?.push({ label: a.label, why: NO_WORK })
    else if (fam !== 'opus' && fam !== 'sonnet') bad(`the transcript model family is ${fam}, not opus or sonnet`)
    if (facts.effort === 'max') bad('effort max')
    // ADR-0032: admit --persona and --high put the persona and the wish for effort high on the label's title event. A member
    // that stage.js meant to run at high (a persona, a task effort or a ## Members line) is not an audit finding at high.
    const titled = events.filter((e) => e.event === 'title' && e.agent === a.label)
    const personaName = ((): string | null => {
      for (let i = titled.length - 1; i >= 0; i--) if (typeof titled[i]?.persona === 'string') return titled[i]?.persona
      return null
    })()
    const personaHigh = facts.effort === 'high' && titled.some((e) => e.high === true)
    if ((facts.effort === 'high' || facts.effort === 'xhigh') && parsed !== undefined && !personaHigh) bad(`effort ${facts.effort} on role ${parsed.role}`)
    if (parsed !== undefined) {
      const why = roleAudit(parsed.role, agentType, facts.tools.map((t) => t.name), roles)
      if (why !== undefined) bad(why)
    }
    if (parsed === undefined) {
      bad('the label does not parse as <slug>-<role>')
      continue
    }
    if (slug === undefined) {
      bad(`the label names no running factory crew (slug ${parsed.slug})`)
      continue
    }
    if (!isObj(roles[parsed.role])) {
      bad(`unknown role ${parsed.role}`)
      continue
    }
    if (!a.hasResult) continue
    const text = textOfResult(a.result)
    if (text === undefined) continue
    // ADR-0020: the k-th distinct agentId under a label (journal `started` order) owns <label>.md for k=1 and <label>.run<k>.md for k>=2.
    const ids: string[] = []
    // Only an agentId that returned a result text has a report to file, so only it holds a rank (an interrupted one never competes).
    for (const o of wfRun.agents) if (o.label === a.label && o.hasResult && textOfResult(o.result) !== undefined && !ids.includes(o.agentId)) ids.push(o.agentId)
    const rank = ids.indexOf(a.agentId) + 1
    const gate = parsed.role === 'qc' || parsed.role === 'stress'
    const file = `${dir}/reports/${slug}/${a.label}${rank >= 2 && !gate ? `.run${rank}` : ''}.md`
    mkdirSync(`${dir}/reports/${slug}`, { recursive: true })
    if (rank >= 2 && gate) {
      bad(`a second agentId (${a.agentId}) under the gate label ${a.label}; the merge and stress gates read one file per label, so it is not filed`)
    } else if (existsSync(file) && readFileSync(file, 'utf8') !== text) {
      bad('a report file with different text already exists; not overwritten')
    } else {
      if (!existsSync(file)) writeFileSync(file, text)
      const when = facts.lastTs === undefined ? NaN : Date.parse(facts.lastTs)
      if (Number.isFinite(when)) utimesSync(file, when / 1000, when / 1000)
    }
    const by = `workflow:${wfRun.id}`
    if (!events.some((e) => e.event === 'spawn' && e.agentId === a.agentId && e.by === by)) {
      const dflt = roleDefaults(roles, parsed.role)
      appendEvent(dir, { event: 'spawn', crew: slug, agent: a.label, agentId: a.agentId, type: agentType ?? 'general-purpose', model: facts.model ?? dflt.model, effort: facts.effort ?? dflt.effort, persona: personaName, by })
    }
    const marker = markerOf(text)
    if (!events.some((e) => e.event === 'report' && e.crew === slug && e.agent === a.label && (e.marker ?? null) === marker)) {
      appendEvent(dir, { event: 'report', crew: slug, agent: a.label, marker })
    }
  }
  recordRestarts(dir, wfRun, crewSlugs, events)
  return audits
}

// ADR-0021 Seams cf: one `restart` event per restarted member, learned from the journal. Per crew and role (tester, builder, writer),
// in `started` order, an agent whose last result is a CHECKPOINT object or a non-object was restarted when a later agent of the same
// crew and role started after that result line; the first such agent not already linked is its successor. No result line: never a restart.
function recordRestarts(dir: string, wfRun: WfRun, crewSlugs: Set<string>, events: Obj[]): void {
  const startedAt = (id: string): number => wfRun.journal.findIndex((l) => l.type === 'started' && l.agentId === id)
  const resultAt = (id: string): number => wfRun.journal.reduce((at, l, i) => (l.type === 'result' && l.agentId === id ? i : at), -1)
  const info = wfRun.agents.map((a) => ({ a, p: parseLabel(a.label), s: startedAt(a.agentId), t: promptTask(a.transcript) }))
  const linked = new Set<string>()
  const nOf = new Map<string, number>()
  for (const x of info) {
    if (x.p === undefined || !crewSlugs.has(x.p.slug) || !['tester', 'builder', 'writer'].includes(x.p.role) || !x.a.hasResult) continue
    const r = x.a.result
    const reason = isObj(r) ? (r.marker === 'CHECKPOINT' ? 'CHECKPOINT' : undefined) : 'no report'
    if (reason === undefined) continue
    const at = resultAt(x.a.agentId)
    const next = info.find((y) => y !== x && y.p?.slug === x.p?.slug && y.p?.role === x.p?.role && (x.t === undefined || y.t === undefined || x.t === y.t) && y.s > at && !linked.has(y.a.agentId))
    if (next === undefined) continue
    linked.add(next.a.agentId)
    const n = (nOf.get(x.a.agentId) ?? 0) + 1
    nOf.set(next.a.agentId, n)
    if (!events.some((e) => e.event === 'restart' && e.crew === x.p?.slug && e.label === x.a.label)) {
      appendEvent(dir, { event: 'restart', crew: x.p.slug, agent: x.a.label, label: x.a.label, n, reason })
    }
  }
}

// Record step, escalations (ADR-0009 "finish, escalation lines"): the event lines the hooks write on the project manager path, so retro
// counts a Workflow crew's stops and spent allowances from events.jsonl the same way. One `tag` line per crew stopped with
// QUESTION, BLOCKED or PROPOSAL in this run's result (once per crew and run), and one `allowance-spent` line naming the QC
// file whose FAIL took the crew's counted QC FAILs past reworkAllowance (once per crew and QC; the count is finish's merge gate's).
export function recordEscalations(dir: string, wfRun: WfRun, crews: Obj[], results: Obj[] | undefined, plan: Obj): void {
  const events = existsSync(`${dir}/events.jsonl`) ? jsonLines(`${dir}/events.jsonl`) : []
  const allowance = intOr(plan.reworkAllowance, 2, 0)
  const since = runStart(plan as any) ?? 0
  for (const c of crews) {
    const slug = String(c.slug)
    const res = results?.find((r) => r.slug === slug)
    const tag = res !== undefined && res.state === 'stopped' && ['QUESTION', 'BLOCKED', 'PROPOSAL'].includes(res.tag) ? String(res.tag) : undefined
    if (tag !== undefined && !events.some((e) => e.event === 'tag' && e.crew === slug && e.run === wfRun.id)) appendEvent(dir, { event: 'tag', crew: slug, agent: slug, tag, run: wfRun.id })
    const fails = countedQc(dir, slug, reportsOf(dir, slug)).filter((f) => qcFails(slug, [f], since) === 1).sort((a, b) => qcK(a.name) - qcK(b.name))
    const spender = fails[allowance]
    if (spender === undefined) continue
    const agent = spender.name.replace(/\.md$/, '')
    if (!events.some((e) => e.event === 'allowance-spent' && e.crew === slug && e.agent === agent)) appendEvent(dir, { event: 'allowance-spent', crew: slug, agent })
  }
  // ADR-0033: one knowledge line per crew and run, from the result's knowledge field (the retro's signal for optional learning)
  for (const c of crews) {
    const slug = String(c.slug)
    const k = results?.find((r) => r.slug === slug)?.knowledge
    if (!isObj(k) || !Number.isInteger(k.items) || k.items < 0 || typeof k.ran !== 'boolean') continue
    if (events.some((e) => e.event === 'knowledge' && e.crew === slug && e.run === wfRun.id)) continue
    appendEvent(dir, { event: 'knowledge', crew: slug, run: wfRun.id, items: k.items, ran: k.ran, sourceChanges: Number.isInteger(k.sourceChanges) && k.sourceChanges >= 0 ? k.sourceChanges : 0 })
  }
}

// 0.31.0 item 3: the evidence lines for the transcripts the model audit passes over (no stop on an obvious call).
const NO_WORK = `no-work transcript: every assistant record has model ${SYNTHETIC_MODEL} (an API error or outage), so no model ran`
const IN_PROGRESS = 'still in progress: no result and no model yet, and its run wrote within the last 30 minutes; the next finish audits it'

// One decision line `audit passed over <label> | <why>` per entry, once: the evidence line that keeps a passed-over transcript auditable.
export function logPassed(dir: string, passed: Audit[]): void {
  for (const p of passed) {
    const line = `audit passed over ${p.label} | ${p.why}`
    if (!(existsSync(`${dir}/decisions.md`) && readFileSync(`${dir}/decisions.md`, 'utf8').includes(line))) appendDecision(dir, line)
  }
}

// Session audit: every Workflow run of the session at or after the run start, in scope as ADR-0009 "finish, session audit" says.
// An agent that did no work (NO_WORK) or is still running in another live workflow (IN_PROGRESS) is not an entry; it goes in `passed`.
export function sessionAudit(dir: string, rootDir: string, thisRunId: string, factorySlugs: Set<string>, waived: Set<string>, passed?: Audit[]): Audit[] {
  const audits: Audit[] = []
  const log = existsSync(`${dir}/decisions.md`) ? readFileSync(`${dir}/decisions.md`, 'utf8') : ''
  const starts = [...log.matchAll(/^## Run (\S+)/gm)].map((m) => Date.parse(m[1] ?? '')).filter((n) => Number.isFinite(n))
  const start = starts.length === 0 ? undefined : Math.max(...starts)
  for (const r of runsOf(rootDir)) {
    if (waived.has(r.id)) continue
    const firsts = r.agents.map((a) => Date.parse(transcriptFacts(a.transcript).firstTs ?? '')).filter((n) => Number.isFinite(n))
    if (start !== undefined && firsts.length > 0 && Math.min(...firsts) < start) continue
    const trussRun = r.agents.every((a) => {
      const p = parseLabel(a.label)
      return p !== undefined && (p.slug === 'truss' || factorySlugs.has(p.slug))
    })
    const typeOf = (a: RunAgent): string => (typeof a.meta?.agentType === 'string' ? a.meta.agentType : '')
    if (!trussRun && !r.agents.some((a) => typeOf(a).startsWith('truss:'))) continue
    for (const a of r.agents) {
      const label = `${r.id}/${a.label}`
      if (!trussRun && typeOf(a).startsWith('truss:')) audits.push({ label, why: `${typeOf(a)} agent in a run that is not truss's` })
      if (typeof a.meta?.model !== 'string' || a.meta.model === '') audits.push({ label, why: 'the meta file has no model' })
      else {
        const facts = transcriptFacts(a.transcript)
        const fam = family(facts.model)
        if (facts.synthetic) passed?.push({ label, why: NO_WORK })
        else if (facts.model === undefined && !a.hasResult && Date.now() - newestMtime(r.dir) <= STALE_MS) passed?.push({ label, why: IN_PROGRESS })
        else if (fam !== 'opus' && fam !== 'sonnet') audits.push({ label, why: `the transcript model family is ${fam}, not opus or sonnet` })
      }
    }
  }
  return audits
}

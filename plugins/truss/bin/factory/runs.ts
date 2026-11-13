// Reading Workflow runs and QC reports: run transcripts, liveness, and the per-crew QC, rework and spend tallies. Moved
// unchanged from bin/factory.ts (0.31.0 item 5). Never imports factory.ts, whose top-level await would make an import cycle.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { flat, isObj, parseLabel, readJson } from '../store.ts'
import type { Obj } from '../store.ts'
import { qcFails, qcK, unbannered } from '../../hooks/register.ts'
import type { QcFile } from '../../hooks/register.ts'

export type RunAgent = { agentId: string; label: string; phase: string | undefined; hasResult: boolean; result: unknown; meta: Obj | undefined; transcript: string }
export type WfRun = { id: string; dir: string; journal: Obj[]; agents: RunAgent[] }
export const jsonLines = (p: string): Obj[] =>
  readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '').flatMap((l) => {
    try {
      const v = JSON.parse(l)
      return isObj(v) ? [v] : []
    } catch {
      return []
    }
  })
// One Workflow run dir read: its journal lines and, per `started` line, the agent's label, last result, meta file and transcript path.
export function runOf(runDir: string): WfRun {
  const dir = flat(runDir)
  const journalPath = `${dir}/journal.jsonl`
  const journal = existsSync(journalPath) ? jsonLines(journalPath) : []
  const agents: RunAgent[] = []
  for (const line of journal) {
    if (line.type !== 'started' || typeof line.agentId !== 'string' || typeof line.label !== 'string') continue
    const results = journal.filter((l) => l.type === 'result' && l.agentId === line.agentId)
    const metaPath = `${dir}/agent-${line.agentId}.meta.json`
    agents.push({
      agentId: line.agentId, label: line.label, phase: typeof line.phase === 'string' ? line.phase : undefined,
      hasResult: results.length > 0, result: results.length > 0 ? results[results.length - 1].result : undefined,
      meta: existsSync(metaPath) ? readJson(metaPath) : undefined, transcript: `${dir}/agent-${line.agentId}.jsonl`,
    })
  }
  return { id: path.basename(dir), dir, journal, agents }
}
// Every run dir under the transcripts root (sorted by name), each read with runOf.
export function runsOf(transcriptsDir: string): WfRun[] {
  const root = flat(transcriptsDir)
  if (!existsSync(root)) return []
  return readdirSync(root).sort().filter((n) => statSync(`${root}/${n}`).isDirectory()).map((n) => runOf(`${root}/${n}`))
}

// The model Claude Code writes on an assistant record it made up itself (an API error, an outage): no model ran.
export const SYNTHETIC_MODEL = '<synthetic>'
// First and last record timestamp, the model, the request effort and the tool uses of an agent transcript. `model` is the
// last real model, never SYNTHETIC_MODEL; `synthetic` is true when the transcript has assistant records and every one is synthetic.
export function transcriptFacts(agentJsonl: string): { firstTs: string | undefined; lastTs: string | undefined; model: string | undefined; effort: string | undefined; tools: { name: string; input: Obj }[]; synthetic: boolean } {
  const facts = { firstTs: undefined as string | undefined, lastTs: undefined as string | undefined, model: undefined as string | undefined, effort: undefined as string | undefined, tools: [] as { name: string; input: Obj }[], synthetic: false }
  let fake = 0
  if (!existsSync(agentJsonl)) return facts
  for (const rec of jsonLines(agentJsonl)) {
    if (typeof rec.timestamp === 'string') {
      facts.firstTs ??= rec.timestamp
      facts.lastTs = rec.timestamp
    }
    const effort = rec.message?.output_config?.effort ?? rec.output_config?.effort
    if (typeof effort === 'string') facts.effort = effort
    if (rec.type === 'assistant' && isObj(rec.message)) {
      if (rec.message.model === SYNTHETIC_MODEL) fake++
      else if (typeof rec.message.model === 'string') facts.model = rec.message.model
      if (Array.isArray(rec.message.content)) for (const c of rec.message.content) if (isObj(c) && c.type === 'tool_use') facts.tools.push({ name: String(c.name), input: isObj(c.input) ? c.input : {} })
    }
  }
  facts.synthetic = fake > 0 && facts.model === undefined
  return facts
}

// The newest mtime (ms) over a run's journal.jsonl and every agent-*.jsonl; 0 when none.
export function newestMtime(runDir: string): number {
  const dir = flat(runDir)
  if (!existsSync(dir)) return 0
  let newest = 0
  for (const n of readdirSync(dir)) if (n === 'journal.jsonl' || (n.startsWith('agent-') && n.endsWith('.jsonl'))) newest = Math.max(newest, statSync(`${dir}/${n}`).mtimeMs)
  return newest
}
// 30 minutes: a run with nothing newer than this is not live (ADR-0009 "start, stale runs", rule 3).
export const STALE_MS = 1800000
// Rule 3: live unless the crew's newest factory spawn (ISO string or ms) and the run's newest mtime are both more than STALE_MS before `now`.
export function isLive(spawnTs: string | number, runDir: string | undefined, now: number): boolean {
  const spawn = typeof spawnTs === 'number' ? spawnTs : Date.parse(spawnTs)
  const newest = runDir === undefined ? 0 : newestMtime(runDir)
  return !(now - spawn > STALE_MS && now - newest > STALE_MS)
}

// The crew's report files D/reports/<slug>/*.md as QcFile[] ({name with .md, text, mtimeMs}), sorted by name.
export function reportsOf(dir: string, slug: string): QcFile[] {
  const d = `${dir}/reports/${slug}`
  if (!existsSync(d)) return []
  return readdirSync(d).filter((n) => n.endsWith('.md')).sort().map((name) => ({ name, text: readFileSync(`${d}/${name}`, 'utf8'), mtimeMs: statSync(`${d}/${name}`).mtimeMs }))
}
// The k of the crew's newest logged re-plan, decision line `re-planned: <slug> from qc-<k>`, or undefined when none.
export function replannedFrom(log: string, slug: string): number | undefined {
  let k: number | undefined
  for (const m of log.matchAll(/^- [^|]*\|\s*re-planned: ([A-Za-z0-9._-]+) from qc-(\d+)\b/gm)) if (m[1] === slug) k = Number(m[2])
  return k
}
// The crew's QC files that count toward its spend: a logged re-plan starts a fresh count, so only -qc-<k> and later count.
export function countedQc(dir: string, slug: string, files: readonly QcFile[]): QcFile[] {
  const p = `${dir}/decisions.md`
  const k = existsSync(p) ? replannedFrom(readFileSync(p, 'utf8'), slug) : undefined
  return k === undefined ? [...files] : files.filter((f) => qcK(f.name) >= k)
}
// The first non-empty line of a report text, trimmed ('' when none), past a BOM and one leading
// "[harness:" paragraph, as stage.js's unbannered and the QC count read the same reply.
export const firstLine = (text: string): string => unbannered(text.replace(/^﻿/, '').replace(/\r/g, '')).split('\n').map((l) => l.trim()).find((l) => l !== '') ?? ''
// The crew's ux report files `<slug>-ux.md` and `<slug>-ux-<n>.md` (interim `.run<k>.md` files never match), with their label number.
const uxReports = (slug: string, files: readonly QcFile[]): (QcFile & { n: number })[] =>
  files.flatMap((f) => {
    const m = /^(.*)-ux(?:-(\d+))?\.md$/.exec(f.name)
    return m !== null && m[1] === slug ? [{ ...f, n: m[2] === undefined ? 1 : Number(m[2]) }] : []
  })
// ADR-0022: the crew's UX: REWORK reports that count toward its spend. They follow the since rule of qcFails, and a logged
// re-plan from qc-<k> counts only those modified at or after <slug>-qc-<k>.md (the bare <slug>-qc.md for k 1), as countedQc does.
export function uxReworks(dir: string, slug: string, files: readonly QcFile[], since = 0): number {
  const p = `${dir}/decisions.md`
  const k = existsSync(p) ? replannedFrom(readFileSync(p, 'utf8'), slug) : undefined
  let from = since
  if (k !== undefined) {
    const qc = files.find((f) => f.name === (k <= 1 ? `${slug}-qc.md` : `${slug}-qc-${k}.md`))
    // a re-plan whose QC file is gone resets the count: no ux report counts
    if (qc === undefined) return 0
    from = Math.max(from, qc.mtimeMs)
  }
  return uxReports(slug, files).filter((f) => f.mtimeMs >= from && firstLine(f.text).startsWith('UX: REWORK')).length
}
// The crew's repair spend: its QC FAIL reports plus its UX: REWORK reports (client ruling: stress-test rounds add nothing).
export function spentOf(dir: string, slug: string, since = 0): number {
  const files = reportsOf(dir, slug)
  return qcFails(slug, countedQc(dir, slug, files), since) + uxReworks(dir, slug, files, since)
}
// ADR-0022: the crew's newest direction, {label, text} of its highest-numbered ux report whose first non-empty line is
// UX: DIRECTION, or null when it has none.
export function directionOf(dir: string, slug: string): { label: string; text: string } | null {
  const dirs = uxReports(slug, reportsOf(dir, slug)).filter((f) => /^UX: DIRECTION\b/.test(firstLine(f.text)))
  if (dirs.length === 0) return null
  const top = dirs.reduce((a, b) => (b.n > a.n ? b : a))
  // the reply as stage.js keeps it (replyOf): no BOM, no harness banner, no CR, trimmed
  return { label: top.name.replace(/\.md$/, ''), text: unbannered(top.text.replace(/^﻿/, '').replace(/\r/g, '')).trim() }
}
// {role: next free label number} from the crew's report files: `<slug>-qc.md` and `-qc-2.md` give {"qc": 3}.
export function labelFromOf(dir: string, slug: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of reportsOf(dir, slug)) {
    if (/\.run\d+\.md$/.test(f.name)) continue
    const p =parseLabel(f.name.replace(/\.md$/, ''))
    if (p !== undefined && p.slug === slug) out[p.role] = Math.max(out[p.role] ?? 1, p.n + 1)
  }
  return out
}
// The crew's newest `by: "factory"` spawn line in D/events.jsonl, or undefined when it has none.
export function factorySpawned(dir: string, slug: string): Obj | undefined {
  const p = `${dir}/events.jsonl`
  if (!existsSync(p)) return undefined
  const lines = jsonLines(p).filter((e) => e.event === 'spawn' && e.crew === slug && e.by === 'factory')
  return lines[lines.length - 1]
}

// The runs of this session: the dirs next to the transcript dir T (T's parent is the runs root).
export const runsNextTo = (transcript: string): WfRun[] => runsOf(path.dirname(flat(transcript).replace(/\/+$/, '')))
export const eventsOf = (dir: string): Obj[] => (existsSync(`${dir}/events.jsonl`) ? jsonLines(`${dir}/events.jsonl`) : [])

// The runs that hold one of the crew's labels, oldest first (newest mtime, then id).
export const crewRunsOf = (runs: WfRun[], slug: string): WfRun[] =>
  runs.filter((r) => r.agents.some((a) => parseLabel(a.label)?.slug === slug)).sort((a, b) => newestMtime(a.dir) - newestMtime(b.dir) || (a.id < b.id ? -1 : 1))
// The task name a member's prompt gives: the `Task: <name>` line directly followed by a `Files you may change:` line, read from
// the first user record of the agent transcript (a string, or an array of text blocks). undefined when there is none.
export function promptTask(transcript: string): string | undefined {
  if (!existsSync(transcript)) return undefined
  const first = jsonLines(transcript).find((rec) => rec.type === 'user')
  const c = first?.message?.content
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: unknown) => (typeof b === 'string' ? b : isObj(b) && typeof b.text === 'string' ? b.text : '')).join('\n') : ''
  const lines = text.split('\n')
  for (let i = 0; i + 1 < lines.length; i++) {
    const m = /^\s*Task: (.+?)\s*$/.exec(lines[i] as string)
    if (m?.[1] !== undefined && /^\s*Files you may change:/.test(lines[i + 1] as string)) return m[1]
  }
  return undefined
}

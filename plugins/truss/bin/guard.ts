// The long-term cost guard (contract-025 section 3, ADR-0034): finds the costs a change leaves with the client (LONG-TERM-COST lines of the designer, checker
// and QC texts, and deterministic triggers in a diff) and holds the plan or the crew until the client approves each through the inbox.
// Imports node: builtins and relative paths only, and never factory.ts (its top-level await would make an import cycle).

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { escalate } from './inbox.ts'
import { flat, git, isObj, packageName, readJsonl, sharedDir, writeJsonAtomic } from './store.ts'

export type Reversal = 'cheap' | 'costly' | 'irreversible'
export type LtcLine = { what: string; later: string; reversal: Reversal }

const KIND = 'long-term-cost'
// Markdown at the line start is allowed (bullet, number, quote, bold, italic, code); the marker itself stays case-sensitive. Keep in step with ltcLinesOf in workflows/stage.js.
const LINE_RE = /^\s*(?:(?:[-*+>]|\d+[.)])\s*)*[*_`]*LONG-TERM-COST[*_`]*\s*:[*_`]*\s*(.*?)[*_`\s]*$/
// A body that is only a none-word means "no cost": the line is not a cost.
const NONE_RE = /^[*_`\s]*(?:none|n\/a|-)?[*_`\s.]*$/i
const sha12 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12)
const sessionOf = (dir: string): string => path.posix.basename(flat(dir).replace(/\/+$/, ''))

/** The LONG-TERM-COST lines of a report text. A line with no valid reversal counts as costly. */
export function ltcLines(text: string): LtcLine[] {
  const out: LtcLine[] = []
  for (const raw of String(text ?? '').split('\n')) {
    const m = LINE_RE.exec(raw.replace(/\r$/, ''))
    if (m === null || NONE_RE.test(m[1])) continue
    const parts = m[1].split('|').map((s) => s.trim())
    let later = ''
    let rev = ''
    for (const p of parts.slice(1)) {
      const l = /^later:\s*(.*)$/i.exec(p)
      const r = /^reversal:\s*(.*)$/i.exec(p)
      if (l !== null && later === '') later = l[1].trim()
      else if (r !== null && rev === '') rev = r[1].trim().toLowerCase()
    }
    const reversal: Reversal = rev === 'cheap' || rev === 'costly' || rev === 'irreversible' ? rev : 'costly'
    out.push({ what: parts[0] === '' ? '(unnamed cost)' : parts[0], later, reversal })
  }
  return out
}

const DEP_KEYS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

// The package names a package.json text declares (empty when it is missing or not JSON).
function depsOf(text: string): Set<string> {
  const out = new Set<string>()
  try {
    const j = JSON.parse(text)
    for (const k of DEP_KEYS) if (isObj(j?.[k])) for (const name of Object.keys(j[k])) out.add(packageName(name))
  } catch {}
  return out
}

/** The deterministic triggers of the change base..head: a dependency, a migration, a *.sql, a *.schema.json or a schema.* file added. */
export function ltcTriggers(repo: string, base: string, head: string): { what: string; later: string; reversal: 'costly' }[] {
  const d = git(repo, ['diff', '--no-renames', '--name-status', base, head])
  if (d.status !== 0) return []
  const out: { what: string; later: string; reversal: 'costly' }[] = []
  const add = (what: string, later: string): void => {
    out.push({ what, later, reversal: 'costly' })
  }
  for (const line of d.out.split('\n')) {
    const [status, file] = line.split('\t')
    if (file === undefined || (status !== 'A' && status !== 'M')) continue
    const p = flat(file)
    const name = path.posix.basename(p)
    if (name === 'package.json') {
      const before = status === 'A' ? new Set<string>() : depsOf(git(repo, ['show', `${base}:${p}`]).out)
      const after = depsOf(git(repo, ['show', `${head}:${p}`]).out)
      for (const dep of [...after].filter((x) => !before.has(x)).sort()) add(`a dependency ${dep} added to ${p}`, 'the client carries its updates, its licence and its supply chain')
      continue
    }
    if (status !== 'A') continue
    if (/(^|\/)migrations\//i.test(p)) add(`a migration ${p}`, 'a stored data shape the client must migrate and keep compatible')
    else if (name.toLowerCase().endsWith('.sql')) add(`a new SQL file ${p}`, 'a stored data shape the client must keep compatible')
    else if (name.toLowerCase().endsWith('.schema.json')) add(`a new schema ${p}`, 'a public data shape every reader is bound to')
    else if (name.toLowerCase().startsWith('schema.')) add(`a new schema file ${p}`, 'a stored data shape every reader is bound to')
  }
  return out
}

// ---- inbox reads: the fold of S/inbox.jsonl (inbox.ts does not export its fold) ----

type Seen = { id: string; ref: string | null; decision: string | null }
function longTermItems(repo: string): Seen[] {
  const items = new Map<string, Seen & { kind: string }>()
  for (const r of readJsonl(`${sharedDir(repo)}/inbox.jsonl`).rows) {
    if (typeof r.id !== 'string') continue
    if (r.op === 'open') {
      if (!items.has(r.id)) items.set(r.id, { id: r.id, kind: String(r.kind), ref: typeof r.ref === 'string' ? r.ref : null, decision: null })
    } else if (r.op === 'resolve') {
      const it = items.get(r.id)
      if (it !== undefined && it.decision === null) it.decision = String(r.decision)
    }
  }
  return [...items.values()].filter((i) => i.kind === KIND)
}

const itemOf = (repo: string, id: string): Seen | undefined => longTermItems(repo).find((i) => i.id === id)

// The id of the item for `ref`: an approved one wins, then an open or rejected one; otherwise a new item is escalated.
function raise(repo: string, dir: string, ref: string, line: LtcLine, crews: string[]): string {
  const same = longTermItems(repo).filter((i) => i.ref === ref)
  const approved = same.find((i) => i.decision === 'approve')
  if (approved !== undefined) return approved.id
  const rejected = same.find((i) => i.decision === 'reject')
  if (rejected !== undefined) return rejected.id
  // an open item falls through: escalate dedupes on the ref and returns it
  return escalate(repo, dir, { kind: KIND, title: `long-term cost: ${line.what}`, detail: `later: ${line.later}\nreversal: ${line.reversal}`, crews, ref, blocking: true }).id
}

function decisionLine(dir: string, text: string): void {
  const p = `${dir}/decisions.md`
  const t = new Date()
  const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  const old = existsSync(p) ? readFileSync(p, 'utf8') : ''
  appendFileSync(p, `${old === '' || old.endsWith('\n') ? '' : '\n'}- ${hm} | ${text} | none | followed\n`)
}

/** Escalates the costly lines of the designer and checker texts of a plan revision `rev`; writes D/ltc-plan.json. */
export function ltcPlan(repo: string, dir: string, texts: string[], rev: string): { ids: string[] } {
  const sid = sessionOf(dir)
  const ids: string[] = []
  const logged = new Set<string>()
  for (const text of texts) {
    for (const line of ltcLines(text)) {
      if (line.reversal === 'cheap') {
        if (logged.has(line.what)) continue
        logged.add(line.what)
        decisionLine(dir, `long-term cost (cheap to reverse): ${line.what} | later: ${line.later}`)
        continue
      }
      const id = raise(repo, dir, `ltc:${sid}:plan:${rev}:${sha12(line.what)}`, line, [])
      if (!ids.includes(id)) ids.push(id)
    }
  }
  writeJsonAtomic(`${dir}/ltc-plan.json`, { rev, ids })
  return { ids }
}

/** The ids in D/ltc-plan.json that are open or rejected. */
export function ltcPlanGate(repo: string, dir: string): string[] {
  const p = `${dir}/ltc-plan.json`
  if (!existsSync(p)) return []
  let ids: unknown = []
  try {
    ids = JSON.parse(readFileSync(p, 'utf8')).ids
  } catch {
    return []
  }
  if (!Array.isArray(ids)) return []
  return ids.map(String).filter((id) => {
    const it = itemOf(repo, id)
    return it === undefined || it.decision === null || it.decision === 'reject'
  })
}

/** Escalates a crew's QC lines and triggers; `refused` is set until each item is resolved approve. */
export function ltcCrewGate(repo: string, dir: string, slug: string, ctx: { qcText: string | null; base: string; head: string }): { refused?: string } {
  const sid = sessionOf(dir)
  const lines = [...(ctx.qcText === null ? [] : ltcLines(ctx.qcText).filter((l) => l.reversal !== 'cheap')), ...ltcTriggers(repo, ctx.base, ctx.head)]
  const ids: string[] = []
  for (const line of lines) {
    const id = raise(repo, dir, `ltc:${sid}:${slug}:${sha12(line.what)}`, line, [slug])
    if (!ids.includes(id)) ids.push(id)
  }
  const pending = ids.filter((id) => itemOf(repo, id)?.decision !== 'approve')
  return pending.length === 0 ? {} : { refused: `long-term-cost: ${pending.join(', ')}` }
}

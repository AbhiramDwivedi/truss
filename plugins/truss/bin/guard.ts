// The long-term cost guard (contract-025 section 3, ADR-0034): finds the costs a change leaves with the client (LONG-TERM-COST lines of the designer, checker
// and QC texts, and deterministic triggers in a diff) and holds the plan or the crew until the client approves each through the inbox.
// Imports node: builtins and relative paths only, and never factory.ts (its top-level await would make an import cycle).

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { escalate, verifiedItems } from './inbox.ts'
import { CliError, flat, git, isObj, packageName, refuse, writeJsonAtomic } from './store.ts'

export type Reversal = 'cheap' | 'costly' | 'irreversible'
export type LtcLine = { what: string; later: string; reversal: Reversal }

const KIND = 'long-term-cost'
// Markdown at the line start is allowed (bullet, number, quote, bold, italic, code); the marker itself stays case-sensitive. Keep in step with ltcLinesOf in workflows/stage.js.
const LINE_RE = /^\s*(?:(?:[-*+>]|\d+[.)])\s*)*[*_`]*LONG-TERM-COST[*_`]*\s*:[*_`]*\s*(.*?)[*_`\s]*$/
// A body that is only an explicit none-word means "no cost": the line is not a cost. An empty body is NOT one: a bare marker has flagged a cost and stays (814f9f9).
const NONE_RE = /^[*_`\s]*(?:none|n\/a|-)[*_`\s.]*$/i
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

// The package names a package.json text declares, per section. Empty text is an empty file; text that is not JSON is null, never an empty set.
function depsOf(text: string): Map<string, Set<string>> | null {
  const out = new Map<string, Set<string>>()
  const body = text.replace(/^﻿/, '')
  if (body.trim() === '') return out
  try {
    const j = JSON.parse(body)
    for (const k of DEP_KEYS) if (isObj(j?.[k])) out.set(k, new Set(Object.keys(j[k]).map(packageName)))
  } catch {
    return null
  }
  return out
}
const allNames = (m: Map<string, Set<string>>): Set<string> => new Set([...m.values()].flatMap((s) => [...s]))

/** The deterministic triggers of the change base..head: a dependency, a migration, a *.sql, a *.schema.json or a schema.* file added. */
export function ltcTriggers(repo: string, base: string, head: string): { what: string; later: string; reversal: 'costly' }[] {
  // -z: a name holding a tab, quote or newline comes back raw, not C-quoted. A failed diff or one over the 1 MB buffer of store.ts git() refuses: no triggers is not an answer.
  let d: { status: number; out: string; err: string }
  try {
    d = git(repo, ['diff', '--no-renames', '--name-status', '-z', base, head])
  } catch (e) {
    if (e instanceof CliError && /ENOBUFS/.test(e.message)) throw refuse({ error: 'long-term-cost: the git diff output is over the 1 MB size limit, so its triggers cannot be read; split the change or have the client check it by hand' })
    throw e
  }
  if (d.status !== 0) throw refuse({ error: `long-term-cost: git diff ${base}..${head} failed, so the change's triggers are unknown: ${d.err}` })
  const out: { what: string; later: string; reversal: 'costly' }[] = []
  const add = (what: string, later: string): void => {
    out.push({ what, later, reversal: 'costly' })
  }
  const toks = d.out.split('\0')
  for (let i = 0; i + 1 < toks.length; i += 2) {
    const status = toks[i]
    const file = toks[i + 1]
    if (file === undefined || (status !== 'A' && status !== 'M')) continue
    const p = flat(file)
    const name = path.posix.basename(p)
    if (name === 'package.json') {
      // the diff status says the file exists at head (A, M) and at base (M): a failed show there is not "no deps"
      const show = (rev: string): string => {
        const r = git(repo, ['show', `${rev}:${p}`])
        if (r.status !== 0) throw refuse({ error: `long-term-cost: git show ${rev}:${p} failed, so the dependencies of ${p} are unknown: ${r.err}` })
        return r.out
      }
      const before = status === 'A' ? new Map<string, Set<string>>() : depsOf(show(base))
      const after = depsOf(show(head))
      if (before === null || after === null) {
        add(`${p} could not be read as JSON, so its dependencies are unknown`, 'the client must check by hand which dependencies the change adds')
        continue
      }
      const known = allNames(before)
      const later = 'the client carries its updates, its licence and its supply chain'
      for (const dep of [...allNames(after)].filter((x) => !known.has(x)).sort()) add(`a dependency ${dep} added to ${p}`, later)
      // a name already in the file, moved out of devDependencies into a shipped section
      for (const dep of [...allNames(after)].filter((x) => known.has(x)).sort()) {
        const shipped = DEP_KEYS.filter((k) => k !== 'devDependencies')
        if (shipped.some((k) => after.get(k)?.has(dep) === true && before.get(k)?.has(dep) !== true)) add(`a dependency ${dep} moved into dependencies in ${p}`, later)
      }
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

// ---- inbox reads: the verified fold of inbox.ts, so a resolve row without client proof never counts ----

type Seen = { id: string; ref: string | null; decision: string | null }
function longTermItems(repo: string): Seen[] {
  const out: Seen[] = []
  for (const [id, it] of verifiedItems(repo)) {
    if (it.open.kind !== KIND) continue
    out.push({ id, ref: typeof it.open.ref === 'string' ? it.open.ref : null, decision: it.resolve === null ? null : String(it.resolve.decision) })
  }
  return out
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

/** The ids in D/ltc-plan.json that are open or rejected. A missing, corrupt or non-array plan refuses: it never opens the gate. */
export function ltcPlanGate(repo: string, dir: string): string[] {
  const p = `${dir}/ltc-plan.json`
  const bad = (why: string): CliError => refuse({ error: `long-term-cost: ltc-plan.json is ${why}; run plan-write to write it again` })
  if (!existsSync(p)) throw bad('missing')
  let ids: unknown
  try {
    ids = JSON.parse(readFileSync(p, 'utf8')).ids
  } catch {
    throw bad('unreadable')
  }
  if (!Array.isArray(ids)) throw bad('not a list of ids')
  return ids.map(String).filter((id) => {
    const it = itemOf(repo, id)
    return it === undefined || it.decision === null || it.decision === 'reject'
  })
}

/** Escalates a crew's QC lines and triggers; `refused` is set until each item is resolved approve. */
export function ltcCrewGate(repo: string, dir: string, slug: string, ctx: { qcText: string | null; base: string; head: string }): { refused?: string } {
  const sid = sessionOf(dir)
  let triggers: ReturnType<typeof ltcTriggers>
  try {
    triggers = ltcTriggers(repo, ctx.base, ctx.head)
  } catch (e) {
    if (e instanceof CliError) return { refused: String(e.body.error ?? e.message) }
    throw e
  }
  const lines = [...(ctx.qcText === null ? [] : ltcLines(ctx.qcText).filter((l) => l.reversal !== 'cheap')), ...triggers]
  const ids: string[] = []
  for (const line of lines) {
    const id = raise(repo, dir, `ltc:${sid}:${slug}:${sha12(line.what)}`, line, [slug])
    if (!ids.includes(id)) ids.push(id)
  }
  const pending = ids.filter((id) => itemOf(repo, id)?.decision !== 'approve')
  return pending.length === 0 ? {} : { refused: `long-term-cost: ${pending.join(', ')}` }
}

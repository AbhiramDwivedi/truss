// The inbox (contract-025 section 3, ADR-0037): escalate, inbox, resolve and mark-applied over S/inbox.jsonl, plus the gate helpers
// blockingFor and budgetRaises. Imports node: builtins and relative paths only, and never factory.ts (its top-level await would make an import cycle).

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configOf, flat, listOf, readJsonl, readText, refuse, sharedDir, str, transcriptsOf, usage, need, withLock } from './store.ts'
import type { Flags, Obj } from './store.ts'

export type EscalateInput = { kind: string; title: string; detail?: string; crews?: string[]; ref?: string | null; blocking?: boolean }
export type EscalateOut = { id: string; kind: string; deduped: boolean; code: string; notified: boolean | null; notifyError?: string }

// kind -> who may resolve it and whether it always blocks its crews.
const KINDS: Record<string, { by: 'client' | 'any'; blocking: boolean }> = {
  'client-question': { by: 'client', blocking: false },
  'scope-change': { by: 'client', blocking: true },
  'client-trigger': { by: 'client', blocking: true },
  'long-term-cost': { by: 'client', blocking: true },
  budget: { by: 'client', blocking: true },
  'allowance-spent': { by: 'client', blocking: true },
  'doctor-bundle': { by: 'client', blocking: true },
  blocked: { by: 'any', blocking: true },
  'stall-unrecovered': { by: 'any', blocking: true },
  'push-pr': { by: 'client', blocking: false },
  'prod-deploy': { by: 'client', blocking: false },
  'intake-triage': { by: 'client', blocking: false },
}
const DECISIONS = ['approve', 'reject', 'answer', 'done', 'dismiss']
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const SLUG_RE = /^[A-Za-z0-9._-]+$/

const sessionOf = (dir: string): string => path.posix.basename(flat(dir).replace(/\/+$/, ''))
const codeHashOf = (id: string, code: string): string => createHash('sha256').update(id + code).digest('hex')

// An item folded from its ops, in file order.
type Item = { open: Obj; crews: string[]; blocking: boolean; held: Set<string>; resolve: Obj | null; applied: string[] }
const heldKey = (session: string, slug: string): string => `${session}\n${slug}`

function fold(rows: Obj[]): Map<string, Item> {
  const items = new Map<string, Item>()
  for (const r of rows) {
    if (typeof r.id !== 'string') continue
    if (r.op === 'open') {
      if (items.has(r.id)) continue
      const crews: string[] = Array.isArray(r.crews) ? r.crews.map(String) : []
      const it: Item = { open: r, crews: [...crews], blocking: r.blocking === true, held: new Set(), resolve: null, applied: [] }
      if (it.blocking) for (const c of crews) it.held.add(heldKey(String(r.session), c))
      items.set(r.id, it)
      continue
    }
    const it = items.get(r.id)
    if (it === undefined) continue
    if (r.op === 'link') {
      const crews: string[] = Array.isArray(r.crews) ? r.crews.map(String) : []
      for (const c of crews) if (!it.crews.includes(c)) it.crews.push(c)
      if (r.blocking === true) {
        it.blocking = true
        for (const c of crews) it.held.add(heldKey(String(r.session), c))
      }
    } else if (r.op === 'resolve') {
      if (it.resolve === null) it.resolve = r
    } else if (r.op === 'applied') {
      it.applied.push(String(r.session))
    }
  }
  return items
}

const readItems = (repo: string): Map<string, Item> => fold(readJsonl(`${sharedDir(repo)}/inbox.jsonl`).rows)

const codeOf = (): string => Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('')
const idOf = (): string => `E-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(3).toString('hex')}`

// Same {v:1, ts, ...} line as factory.ts appendEvent. Ids and kinds only: never a title, detail, note, quote or code.
function event(dir: string, obj: Obj): void {
  mkdirSync(dir, { recursive: true })
  appendFileSync(`${flat(dir)}/events.jsonl`, JSON.stringify({ v: 1, ts: new Date().toISOString(), ...obj }) + '\n')
}

/** Raises an item to the inbox of the session `dir` names. */
export function escalate(repo: string, dir: string, input: EscalateInput): EscalateOut {
  const spec = KINDS[input.kind]
  if (spec === undefined) throw usage(`unknown kind: ${input.kind}; kinds: ${Object.keys(KINDS).join(', ')}`)
  const title = String(input.title ?? '').trim().slice(0, 200)
  if (title === '') throw usage('missing --title')
  const detail = String(input.detail ?? '').slice(0, 4000)
  const crews = (input.crews ?? []).map(String)
  for (const c of crews) if (!SLUG_RE.test(c)) throw usage(`bad crew slug: ${c}`)
  const ref = input.ref === undefined || input.ref === null || input.ref === '' ? null : String(input.ref)
  const blocking = spec.blocking || input.blocking === true
  const session = sessionOf(dir)
  const S = sharedDir(repo)
  const file = `${S}/inbox.jsonl`
  const code = codeOf()
  let open: Obj | null = null
  let out: EscalateOut | null = null
  // one lock: the dedupe read, the check and the single append
  withLock(S, 'inbox', () => {
    const ts = new Date().toISOString()
    if (ref !== null) {
      for (const [id, it] of fold(readJsonl(file).rows)) {
        if (it.resolve === null && it.open.kind === input.kind && it.open.ref === ref) {
          const link: Obj = { v: 1, op: 'link', id, ts, session, crews }
          if (blocking) link.blocking = true
          appendFileSync(file, JSON.stringify(link) + '\n')
          out = { id, kind: input.kind, deduped: true, code: '', notified: null }
          return
        }
      }
    }
    const id = idOf()
    open = { v: 1, op: 'open', id, ts, kind: input.kind, session, crews, ref, blocking, title, detail, codeHash: codeHashOf(id, code) }
    appendFileSync(file, JSON.stringify(open) + '\n')
    out = { id, kind: input.kind, deduped: false, code, notified: null }
  })
  const res = out as unknown as EscalateOut
  if (res.deduped) return { ...res, code: '' }
  const row = open as unknown as Obj
  const crew = crews[0] ?? 'main' // the schema requires a crew; 'main' is the run itself
  event(dir, { event: 'escalate', crew, id: row.id, kind: row.kind, blocking })
  if (typeof configOf(repo).notify === 'string') {
    const n = notify(repo, { ...row, code })
    res.notified = n.ok
    if (!n.ok) {
      res.notifyError = n.error
      event(dir, { event: 'notify-error', crew, id: row.id, error: n.error })
    }
  }
  return res
}

// notify-run.ts in a child, after the lock is released: ok, or the failure text (at most 200 characters).
function notify(repo: string, row: Obj): { ok: boolean; error: string } {
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'notify-run.ts')
  const r = spawnSync(process.execPath, [bin], { input: JSON.stringify({ repo, row }), encoding: 'utf8', timeout: 15000, windowsHide: true })
  if (r.error) return { ok: false, error: `notify did not run: ${r.error.message}`.slice(0, 200) }
  if (r.status === 0) return { ok: true, error: '' }
  let error = ''
  try {
    const j = JSON.parse((r.stdout ?? '').trim().split('\n').pop() ?? '')
    if (typeof j?.error === 'string') error = j.error
  } catch {
    error = ''
  }
  return { ok: false, error: (error || `notify exited ${r.status}`).slice(0, 200) }
}

/** The ids of the open blocking items that hold the crew `slug` of `session`. */
export function blockingFor(repo: string, session: string, slug: string): string[] {
  const key = heldKey(session, slug)
  const ids: string[] = []
  for (const [id, it] of readItems(repo)) if (it.resolve === null && it.held.has(key)) ids.push(id)
  return ids
}

/** The raises of the approved budget resolves of `session`: [{ref, raiseUsd}]. */
export function budgetRaises(repo: string, session: string): { ref: string; raiseUsd: number }[] {
  const out: { ref: string; raiseUsd: number }[] = []
  for (const it of readItems(repo).values()) {
    const r = it.resolve
    if (r === null || it.open.kind !== 'budget' || r.decision !== 'approve' || r.session !== session) continue
    if (typeof r.raiseUsd !== 'number' || !(r.raiseUsd > 0) || typeof it.open.ref !== 'string') continue
    out.push({ ref: it.open.ref, raiseUsd: r.raiseUsd })
  }
  return out
}

// The text of a main-thread line a human typed, or null: not isMeta, not isSidechain, string content or text blocks with no tool_result.
function typedText(row: Obj): string | null {
  if (row.type !== 'user' || row.isMeta || row.isSidechain || row.isCompactSummary || row.isVisibleInTranscriptOnly) return null
  if (row.origin !== undefined && row.origin?.kind !== 'human') return null
  const c = row.message?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c) || c.length === 0) return null
  if (c.some((b: any) => b?.type === 'tool_result')) return null
  if (!c.every((b: any) => b?.type === 'text' && typeof b.text === 'string')) return null
  return c.map((b: any) => b.text).join('\n')
}

// The newest typed prompt of this session's main transcript, newer than the open op, holding the id, the code and the decision word right before the id.
function typedProof(session: string, open: Obj, decision: string, code: string): string | null {
  const main = transcriptsOf(session).main
  if (main === null) return null
  const after = Date.parse(open.ts)
  const word = new RegExp(`(^|[^A-Za-z0-9])${decision}[ \\t]+${open.id.replace(/[^A-Za-z0-9]/g, '\\$&')}($|[^A-Za-z0-9])`)
  let found: string | null = null
  for (const row of readJsonl(main).rows) {
    const text = typedText(row)
    if (text === null) continue
    const at = Date.parse(row.timestamp)
    if (!Number.isFinite(at) || !(at > after)) continue
    if (text.includes(open.id) && text.includes(code) && word.test(text)) found = text
  }
  return found === null ? null : (found as string).slice(0, 1000)
}

function resolveItem(f: Flags): Obj {
  const repo = flat(need(f, 'repo'))
  const dir = need(f, 'dir')
  const id = need(f, 'id')
  const decision = need(f, 'decision')
  const by = need(f, 'by')
  const code = need(f, 'code')
  if (!DECISIONS.includes(decision)) throw usage(`--decision must be one of ${DECISIONS.join(', ')}`)
  if (by !== 'client' && by !== 'pm') throw usage('--by must be client or pm')
  const note = (str(f, 'note') ?? '').slice(0, 4000)
  const rawRaise = str(f, 'raise-usd')
  let raiseUsd: number | undefined
  if (rawRaise !== undefined) {
    raiseUsd = Number(rawRaise)
    if (!Number.isFinite(raiseUsd) || raiseUsd <= 0) throw usage('--raise-usd must be a number above 0')
  }
  const session = sessionOf(dir)
  const S = sharedDir(repo)
  const file = `${S}/inbox.jsonl`
  let quote: string | null = null
  let firstCrew = 'main'
  withLock(S, 'inbox', () => {
    const it = fold(readJsonl(file).rows).get(id)
    if (it === undefined) throw refuse({ error: `no such item: ${id}` })
    if (it.resolve !== null) throw refuse({ error: `${id} is already resolved` })
    const kind = String(it.open.kind)
    firstCrew = it.crews[0] ?? 'main'
    if (by === 'pm' && KINDS[kind]?.by !== 'any') throw refuse({ error: `${kind} is resolved by the client, not by pm` })
    if (raiseUsd !== undefined && kind !== 'budget') throw refuse({ error: '--raise-usd is for the budget kind only' })
    if (codeHashOf(id, code) !== it.open.codeHash) throw refuse({ error: 'wrong code' })
    if (by === 'client') {
      quote = typedProof(session, it.open, decision, code)
      if (quote === null) throw refuse({ error: `no prompt typed by the client resolves ${id}: the client types /truss:inbox ${decision} ${id} <code> in this session` })
    }
    const op: Obj = { v: 1, op: 'resolve', id, ts: new Date().toISOString(), session, decision, by, note, quote }
    if (raiseUsd !== undefined) op.raiseUsd = raiseUsd
    appendFileSync(file, JSON.stringify(op) + '\n')
  })
  event(dir, { event: 'resolve', crew: firstCrew, id, decision, by })
  return { id, state: 'resolved', decision, quote }
}

function markApplied(f: Flags): Obj {
  const repo = flat(need(f, 'repo'))
  const id = need(f, 'id')
  const session = sessionOf(need(f, 'dir'))
  const S = sharedDir(repo)
  const file = `${S}/inbox.jsonl`
  withLock(S, 'inbox', () => {
    const it = fold(readJsonl(file).rows).get(id)
    if (it === undefined) throw refuse({ error: `no such item: ${id}` })
    if (it.resolve === null) throw refuse({ error: `${id} is not resolved` })
    if (it.applied.includes(session)) return
    appendFileSync(file, JSON.stringify({ v: 1, op: 'applied', id, ts: new Date().toISOString(), session }) + '\n')
  })
  return { id }
}

function listItems(f: Flags): Obj {
  const repo = flat(need(f, 'repo'))
  const dirFlag = str(f, 'dir')
  const session = dirFlag === undefined ? null : sessionOf(dirFlag)
  const kind = str(f, 'kind')
  const crew = str(f, 'crew')
  const all = readItems(repo)
  const items: Obj[] = []
  let open = 0
  for (const [id, it] of all) {
    const state = it.resolve === null ? 'open' : 'resolved'
    if (state === 'open') open++
    const applied = session === null ? it.applied.length > 0 : it.applied.includes(session)
    if (f.open === true && state !== 'open') continue
    if (f.unapplied === true && (state !== 'resolved' || applied)) continue
    if (kind !== undefined && it.open.kind !== kind) continue
    if (crew !== undefined && !it.crews.includes(crew)) continue
    const row: Obj = { id, ts: it.open.ts, kind: it.open.kind, session: it.open.session, crews: it.crews, ref: it.open.ref ?? null, blocking: it.blocking, title: it.open.title, state }
    if (it.resolve !== null) {
      row.decision = it.resolve.decision
      row.by = it.resolve.by
      row.note = it.resolve.note
      row.quote = it.resolve.quote ?? null
      if (it.resolve.raiseUsd !== undefined) row.raiseUsd = it.resolve.raiseUsd
    }
    row.applied = applied
    items.push(row)
  }
  return { items, open }
}

const textOf = (f: Flags, key: string): string | undefined => {
  const file = str(f, `${key}-file`)
  if (file !== undefined) return readText(file).replace(/\s+$/, '')
  return str(f, key)
}

export const INBOX_COMMANDS: Record<string, (f: Flags) => Obj> = {
  escalate: (f) => {
    const kind = need(f, 'kind')
    const title = textOf(f, 'title')
    if (title === undefined || title === '') throw usage('missing --title or --title-file')
    const ref = str(f, 'ref')
    const out = escalate(flat(need(f, 'repo')), need(f, 'dir'), { kind, title, detail: textOf(f, 'detail'), crews: listOf(f, 'crew'), ref: ref === undefined ? null : ref, blocking: f.blocking === true || f.blocking === 'true' })
    const body: Obj = { id: out.id, kind: out.kind, deduped: out.deduped }
    body.code = out.deduped ? null : out.code
    body.notified = out.notified
    if (out.notifyError !== undefined) body.notifyError = out.notifyError
    return body
  },
  inbox: listItems,
  resolve: resolveItem,
  'mark-applied': markApplied,
}

// The inbox (contract-025 section 3, ADR-0037): escalate, inbox, resolve and mark-applied over S/inbox.jsonl, plus the gate helpers
// blockingFor and budgetRaises. Imports node: builtins and relative paths only, and never factory.ts (its top-level await would make an import cycle).

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CliError, commonDir, configOf, flat, listOf, proofTranscriptRoot, readJsonl, readProofFile, readText, refuse, sharedDir, str, usage, need, withLock, writeJsonAtomic } from './store.ts'
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

// An item folded from its ops, in file order. resolve is the first resolve row that counts (see verifiedItems), else null; a row that did not
// count leaves reopened (why, and the row's by, ts and decision); a client resolve counted by proof carries the typed text as its note; noteUnbound marks one whose stored note differed.
export type Item = { open: Obj; crews: string[]; blocking: boolean; held: Set<string>; resolve: Obj | null; applied: string[]; reopened?: { reason: string; by: unknown; ts: unknown; decision: unknown }; noteUnbound?: boolean }
type RawItem = Item & { rows: Obj[] }
const heldKey = (session: string, slug: string): string => `${session}\n${slug}`

function fold(rows: Obj[]): Map<string, RawItem> {
  const items = new Map<string, RawItem>()
  for (const r of rows) {
    if (typeof r.id !== 'string') continue
    if (r.op === 'open') {
      if (items.has(r.id)) continue
      const crews: string[] = Array.isArray(r.crews) ? r.crews.map(String) : []
      const it: RawItem = { open: r, crews: [...crews], blocking: r.blocking === true, held: new Set(), resolve: null, applied: [], rows: [] }
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
      it.rows.push(r)
    } else if (r.op === 'applied') {
      it.applied.push(String(r.session))
    }
  }
  return items
}

// ---- the verified fold: the one reading of the inbox (ADR-0037) ----

// A candidate typed row of a main transcript: the row, its typed text, and whether its parentUuid resolves to an earlier row.
type Cand = { row: Obj; text: string; at: number; chain: boolean }
type FileScan = { sig: string; ids: Set<string>; cands: Map<string, Cand[]> }
// One scan per file and process, keyed on path; valid while path, size, mtime, ctime and inode are the same. Nothing is kept on disk.
const scans = new Map<string, FileScan>()

// Every typed candidate row that names one of `ids`, from a byte search for each id before any line is parsed. The file is read once.
function scanFile(main: string, session: string, ids: Set<string>): FileScan | null {
  let st: { size: number; mtimeMs: number; ctimeMs: number; ino: number }
  try {
    st = statSync(main)
  } catch {
    return null
  }
  const sig = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`
  const had = scans.get(main)
  if (had !== undefined && had.sig === sig && [...ids].every((i) => had.ids.has(i))) return had
  const want = new Set(ids)
  if (had !== undefined && had.sig === sig) for (const i of had.ids) want.add(i)
  let buf: Buffer
  try {
    buf = readProofFile(main)
  } catch {
    return null // unreadable, or over the size a Buffer holds: the row does not count
  }
  const cands = new Map<string, Cand[]>()
  const typed = Buffer.from('"type":"user"')
  for (const id of want) {
    const list: Cand[] = []
    const needle = Buffer.from(id)
    let seenLine = -1
    for (let p = buf.indexOf(needle); p !== -1; p = buf.indexOf(needle, p + needle.length)) {
      const ls = buf.lastIndexOf(10, p) + 1
      if (ls === seenLine) continue
      seenLine = ls
      let le = buf.indexOf(10, p)
      if (le === -1) le = buf.length
      const t = buf.indexOf(typed, ls)
      if (t === -1 || t >= le) continue
      let row: any
      try {
        row = JSON.parse(buf.toString('utf8', ls, le))
      } catch {
        continue
      }
      if (row === null || typeof row !== 'object' || typeof row.uuid !== 'string' || row.sessionId !== session) continue
      const text = typedText(row)
      if (text === null) continue
      list.push({ row, text, at: Date.parse(row.timestamp), chain: chainOk(buf, ls, row) })
    }
    cands.set(id, list)
  }
  const scan: FileScan = { sig, ids: want, cands }
  scans.set(main, scan)
  return scan
}

// The row's parentUuid resolves to an earlier row of the same file; null only when no user or assistant row comes before it.
function chainOk(buf: Buffer, ls: number, row: Obj): boolean {
  const parent = row.parentUuid
  if (parent === null) {
    const before = buf.subarray(0, ls)
    return before.indexOf('"type":"user"') === -1 && before.indexOf('"type":"assistant"') === -1
  }
  if (typeof parent !== 'string' || parent === '') return false
  const needle = Buffer.from(`"uuid":${JSON.stringify(parent)}`)
  let from = ls - needle.length
  while (from >= 0) {
    const p = buf.lastIndexOf(needle, from)
    if (p === -1) return false
    const s = buf.lastIndexOf(10, p) + 1
    let e = buf.indexOf(10, p)
    if (e === -1) e = buf.length
    try {
      if (JSON.parse(buf.toString('utf8', s, e)).uuid === parent) return true
    } catch {
      // a match inside a line that is not a row
    }
    from = p - 1
  }
  return false
}

// The main transcript of `session` under the proof root, or null.
function proofMain(session: string): string | null {
  if (!SLUG_RE.test(session) || session === '.' || session === '..') return null
  const root = proofTranscriptRoot()
  let projects: string[]
  try {
    projects = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch {
    return null
  }
  for (const proj of projects) {
    const main = `${root}/${proj}/${session}.jsonl`
    if (existsSync(main)) return main
  }
  return null
}

const commonOf = (dir: string): string | null => {
  try {
    return commonDir(dir)
  } catch {
    return null // not a git repo: commonDir throws a usage error
  }
}

/**
 * A typed line proves a resolve only for the repo its session ran in: inbox.jsonl is forgeable, so an open row copied from another repo
 * would otherwise be proved by that repo's typed line. The transcript row's cwd is the only repo binding the client's file holds. A cwd under
 * the repo (its worktrees included) or in the same git common dir passes; an existing cwd of another repo is refused. A row with no cwd, or
 * a cwd that no longer exists and is not under the repo, cannot be shown foreign and passes.
 */
function ownsCwd(repo: string, cwd: unknown): boolean {
  if (typeof cwd !== 'string' || cwd === '') return true
  const c = flat(cwd).replace(/\/+$/, '')
  const r = flat(repo).replace(/\/+$/, '')
  if (c === r || c.startsWith(r + '/')) return true
  if (!existsSync(c)) return true
  const theirs = commonOf(c)
  const ours = commonOf(r)
  return ours === null || (theirs !== null && theirs === ours)
}

const norm = (s: string): string => s.trim().split(/\s+/).filter(Boolean).join(' ')

// A quote shown to anyone: the item's code token becomes [code]. A reopened item makes its spent code live again, so no listing prints it.
const maskCode = (quote: unknown, id: string, codeHash: unknown): unknown =>
  typeof quote === 'string' ? quote.replace(/\S+/g, (tok) => (codeHashOf(id, tok) === codeHash ? '[code]' : tok)) : quote

// The typed line that proves a resolve of `open` (decision, raise, and the stored quote when the row has one): its newest candidate when
// `last`, else its first. rest is what follows `<decision> <id> <code> [raise <usd>]`, whitespace normalised.
function proof(repo: string, open: Obj, c: { decision: unknown; raiseUsd?: unknown; quote?: unknown }, cands: Cand[], last: boolean): { text: string; rest: string } | null {
  if (typeof c.decision !== 'string' || !DECISIONS.includes(c.decision)) return null
  if (c.raiseUsd !== undefined && typeof c.raiseUsd !== 'number') return null
  const after = Date.parse(open.ts)
  let found: { text: string; rest: string } | null = null
  for (const k of cands) {
    if (!k.chain || !Number.isFinite(k.at) || !(k.at > after)) continue
    if (c.quote !== undefined && !(typeof c.quote === 'string' && c.quote !== '' && k.text.startsWith(c.quote))) continue
    const t = argsOf(k.text).split(/\s+/)
    if (t[0] !== c.decision || t[1] !== open.id || t[2] === undefined || codeHashOf(open.id, t[2]) !== open.codeHash) continue
    let from = 3
    if (c.raiseUsd !== undefined) {
      if (t[3] !== 'raise' || !/^\d+(\.\d+)?$/.test(t[4] ?? '') || Number(t[4]) !== c.raiseUsd) continue
      from = 5
    } else if (t[3] === 'raise' && /^\d+(\.\d+)?$/.test(t[4] ?? '')) continue // a typed raise is never dropped: a row without raiseUsd cannot stand for it
    if (!ownsCwd(repo, k.row.cwd)) continue
    found = { text: k.text, rest: t.slice(from).join(' ') }
    if (!last) break
  }
  return found
}

/**
 * The items of the shared inbox with their resolve rows verified at read time. A resolve row counts when its kind allows `by: any` and the
 * row says pm or client, or when the row is `by: client` and a typed row of the main transcript of the session it names proves it (see
 * proof). An unverified row counts as absent: the item is open, with `reopened` saying why. The first verified row wins.
 */
export function verifiedItems(repo: string): Map<string, Item> {
  const items = fold(readJsonl(`${sharedDir(repo)}/inbox.jsonl`).rows)
  const ask = new Map<string, Set<string>>() // session -> ids whose client rows need a transcript
  const needsProof = (_it: RawItem, r: Obj): boolean => r.by === 'client'
  for (const [id, it] of items) for (const r of it.rows) if (needsProof(it, r) && typeof r.session === 'string') (ask.get(r.session) ?? ask.set(r.session, new Set()).get(r.session)!).add(id)
  const scanned = new Map<string, { scan: FileScan | null; main: string | null }>()
  for (const [session, ids] of ask) {
    const main = proofMain(session)
    scanned.set(session, { main, scan: main === null ? null : scanFile(main, session, ids) })
  }
  for (const it of items.values()) {
    const kind = String(it.open.kind)
    for (const r of it.rows) {
      let why = ''
      let proven: string | null = null
      if (r.by !== 'client' && r.by !== 'pm') why = `the row says by ${JSON.stringify(r.by)}, not client or pm`
      else if (r.by === 'pm' && KINDS[kind]?.by !== 'any') why = `${kind} is resolved by the client, not by pm`
      else if (r.by === 'pm') why = ''
      else {
        const anyKind = KINDS[kind]?.by === 'any' // the row counts either way; an unproven note is flagged, never shown as the client's
        const s = typeof r.session === 'string' ? scanned.get(r.session) : undefined
        if (s === undefined) why = 'the row names no session'
        else if (s.main === null) why = `no transcript of session ${r.session} under ${proofTranscriptRoot()}`
        else if (s.scan === null) why = `the transcript of session ${r.session} cannot be read`
        else {
          const p = proof(repo, it.open, r, s.scan.cands.get(String(it.open.id)) ?? [], false)
          if (p === null) why = `no line typed by the client in session ${r.session} backs this ${String(r.decision)}`
          else {
            proven = p.rest.slice(0, 4000)
            if (norm(String(r.note ?? '')) !== '' && norm(String(r.note)).slice(0, 4000) !== proven) it.noteUnbound = true
          }
        }
        if (anyKind && why !== '') {
          why = ''
          if (norm(String(r.note ?? '')) !== '') it.noteUnbound = true
        }
      }
      if (why === '') {
        // a row counted by proof carries the client's typed text as its note, never the stored one, for every reader of the fold
        it.resolve = proven === null ? r : { ...r, note: proven }
        it.reopened = undefined
        break
      }
      it.reopened ??= { reason: why, by: r.by, ts: r.ts, decision: r.decision }
    }
  }
  return items
}

const codeFile = (sessionDir: string, id: string): string => `${sessionDir}/escalate-code-${id}.json`

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
  // Everything that can throw but the append runs before it: a bad truss.json or an unwritable session dir leaves no item whose code was never shown.
  const notifies = typeof configOf(repo).notify === 'string'
  mkdirSync(dir, { recursive: true })
  let open: Obj | null = null
  let out: EscalateOut | null = null
  // one lock: the dedupe read, the check and the single append
  withLock(S, 'inbox', () => {
    const ts = new Date().toISOString()
    if (ref !== null) {
      for (const [id, it] of verifiedItems(repo)) {
        if (it.resolve === null && it.open.kind === input.kind && it.open.ref === ref) {
          const link: Obj = { v: 1, op: 'link', id, ts, session, crews }
          if (blocking) link.blocking = true
          appendFileSync(file, JSON.stringify(link) + '\n')
          out = { id, kind: input.kind, deduped: true, code: '', notified: null }
          return
        }
      }
    }
    // 24-bit ids can collide across sessions: redraw while the id is already in the shared file (read under the lock)
    const taken = existsSync(file) ? readFileSync(file, 'utf8') : ''
    let id = idOf()
    while (taken.includes(`"id":"${id}"`)) id = idOf()
    open = { v: 1, op: 'open', id, ts, kind: input.kind, session, crews, ref, blocking, title, detail, codeHash: codeHashOf(id, code) }
    // the code outlives a process that dies after the append; removed when the item resolves, listed only by `inbox --recover-codes`
    writeJsonAtomic(codeFile(flat(dir), id), { id, code }, { mode: 0o600 })
    appendFileSync(file, JSON.stringify(open) + '\n')
    out = { id, kind: input.kind, deduped: false, code, notified: null }
  })
  const res = out as unknown as EscalateOut
  if (res.deduped) return { ...res, code: '' }
  const row = open as unknown as Obj
  const crew = crews[0] ?? 'main' // the schema requires a crew; 'main' is the run itself
  // the item exists and the code is in res: nothing below may throw it away
  const safeEvent = (obj: Obj): void => {
    try {
      event(dir, obj)
    } catch {
      // the event log is best effort here
    }
  }
  safeEvent({ event: 'escalate', crew, id: row.id, kind: row.kind, blocking })
  if (notifies) {
    const n = notify(repo, { ...row, code })
    res.notified = n.ok
    if (!n.ok) {
      res.notifyError = n.error
      safeEvent({ event: 'notify-error', crew, id: row.id, error: n.error })
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
  for (const [id, it] of verifiedItems(repo)) if (it.resolve === null && it.held.has(key)) ids.push(id)
  return ids
}

/** The raises of the approved budget resolves of `session`: [{ref, raiseUsd}]. The session is the one the ref names (budget:<open-session>:...), whichever session resolved it. */
export function budgetRaises(repo: string, session: string): { ref: string; raiseUsd: number }[] {
  const out: { ref: string; raiseUsd: number }[] = []
  for (const it of verifiedItems(repo).values()) {
    const r = it.resolve
    if (r === null || it.open.kind !== 'budget' || r.decision !== 'approve') continue
    if (typeof r.raiseUsd !== 'number' || !(r.raiseUsd > 0) || typeof it.open.ref !== 'string' || !it.open.ref.startsWith(`budget:${session}:`)) continue
    out.push({ ref: it.open.ref, raiseUsd: r.raiseUsd })
  }
  return out
}

// The text of a main-thread line a human typed, or null: not isMeta, not isSidechain, string content or text blocks with no tool_result.
function typedText(row: Obj): string | null {
  if (row.type !== 'user' || row.isMeta || row.isSidechain || row.isCompactSummary || row.isVisibleInTranscriptOnly) return null
  if (row.origin !== undefined && row.origin?.kind !== 'human') return null
  // A /loop wakeup line has no origin and no isMeta but its text is what the agent passed to ScheduleWakeup.
  if (row.wakeupSource !== undefined || row.scheduledTaskId !== undefined || row.scheduledFireId !== undefined) return null
  if (row.turnOrigin !== undefined && row.turnOrigin !== 'human') return null
  if (row.promptSource !== undefined && row.promptSource !== 'typed') return null
  const c = row.message?.content
  let text: string
  if (typeof c === 'string') text = c
  else if (!Array.isArray(c) || c.length === 0) return null
  else if (c.some((b: any) => b?.type === 'tool_result')) return null
  else if (!c.every((b: any) => b?.type === 'text' && typeof b.text === 'string')) return null
  else text = c.map((b: any) => b.text).join('\n')
  if (OUTPUT_TAG.test(text)) return null
  // A plain typed prompt carries origin human and promptSource typed. Without that, only the slash-command shape counts: the /truss:inbox
  // rows on this machine's real transcripts have origin human and no promptSource, or no origin at all, and promptId is not always there.
  if (row.origin !== undefined && row.promptSource === 'typed') return text
  return row.promptSource === undefined || row.promptSource === 'typed' ? (SLASH_SHAPE.test(text) ? text : null) : null
}

// Claude Code records the output of a bash-mode or local command, and an agent's return, as a user line; that text is not typed.
const OUTPUT_TAG = /<(bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-stderr|local-command-caveat|task-notification)>/
const SLASH_SHAPE = /^\s*(<command-message>[^<]*<\/command-message>\s*)?<command-name>\/truss:inbox<\/command-name>\s*<command-args>[\s\S]*<\/command-args>\s*$/

// What the client typed after the command name: the <command-args> text of a slash command, else the whole prompt without a leading /truss:inbox.
function argsOf(text: string): string {
  const m = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)
  return (m === null ? text.replace(/^\s*\/truss:inbox(?=\s)/, '') : m[1]).trim()
}

// The newest typed prompt of this session's main transcript, newer than the open op, holding the id, the code and the decision word right before the id.
// With a raise, the typed line is `<decision> <id> <code> raise <usd> [note]`: the amount is the one the client typed, not the agent's flag.
// The decision is the first word the client typed, directly before the id; the code is the token after it (see proof).
function typedProof(repo: string, session: string, open: Obj, decision: string, raiseUsd?: number): { quote: string; rest: string } | { missing: string; raiseTyped?: string } {
  const main = proofMain(session)
  if (main === null) return { missing: `no transcript of session ${session} under ${proofTranscriptRoot()}` }
  const scan = scanFile(main, session, new Set([String(open.id)]))
  const p = scan === null ? null : proof(repo, open, { decision, raiseUsd }, scan.cands.get(String(open.id)) ?? [], true)
  if (p !== null) return { quote: p.text.slice(0, 1000), rest: p.rest }
  if (raiseUsd === undefined && scan !== null) {
    // the client typed a raise but the agent left out --raise-usd: the flag is the cause, not a missing prompt
    for (const k of scan.cands.get(String(open.id)) ?? []) {
      const t = argsOf(k.text).split(/\s+/)
      if (k.chain && t[0] === decision && t[1] === open.id && t[2] !== undefined && codeHashOf(open.id, t[2]) === open.codeHash && t[3] === 'raise' && /^\d+(\.\d+)?$/.test(t[4] ?? '')) {
        return { missing: '', raiseTyped: t[4] }
      }
    }
  }
  return { missing: '' }
}

/**
 * The typed client proof `approve --by client` needs (ADR-0045): null when `item` is a client-trigger item of this session (`dir`) whose ref is
 * the run goal or one of `clientGoals`, resolved approve by the client with a typed line that verifiedItems holds, and not superseded by a later
 * open row of the same kind, session and ref. Else the reason it does not count. Fails closed: a stored row alone proves nothing.
 */
export function approvalProof(repo: string, dir: string, item: string | undefined, clientGoals: string[]): string | null {
  if (item === undefined || item === '') return 'approve --by client needs --item <E-id>: the client-trigger item for this plan, which the client approves by typing /truss:inbox approve <E-id> <code>'
  const items = verifiedItems(repo)
  const it = items.get(item)
  if (it === undefined) return `no such item: ${item}`
  const session = sessionOf(dir)
  if (it.open.kind !== 'client-trigger') return `${item} is a ${String(it.open.kind)} item, not the client-trigger item that approves a plan`
  if (it.open.session !== session) return `${item} was opened for another truss dir, not ${session}`
  const ref = it.open.ref
  if (ref !== 'run' && !(typeof ref === 'string' && clientGoals.includes(ref))) return `${item} is for ${JSON.stringify(ref ?? null)}, not the run goal or a client goal of this plan`
  let later = false
  for (const [id, o] of items) {
    if (id === item) later = true
    else if (later && o.open.kind === it.open.kind && o.open.session === it.open.session && o.open.ref === it.open.ref) return `${item} is superseded by ${id}`
  }
  const r = it.resolve
  if (r === null) return `no prompt typed by the client approves ${item}: the client types /truss:inbox approve ${item} <code>`
  if (r.by !== 'client' || r.decision !== 'approve') return `${item} was resolved ${String(r.decision)}, not approve`
  return null
}

/**
 * A plan the client's typed approve already approved (see onPlanApprove): the first `approve --by client --item <id>` with the same proof
 * confirms it, once, by marking the item applied for this session; any later call finds it applied and refuses. True when it confirmed.
 */
export function confirmApproval(repo: string, dir: string, item: string | undefined, clientGoals: string[]): boolean {
  if (approvalProof(repo, dir, item, clientGoals) !== null) return false
  const session = sessionOf(dir)
  const S = sharedDir(repo)
  let confirmed = false
  withLock(S, 'inbox', () => {
    const it = verifiedItems(repo).get(String(item))
    if (it === undefined || it.resolve === null || it.applied.includes(session)) return
    appendFileSync(`${S}/inbox.jsonl`, JSON.stringify({ v: 1, op: 'applied', id: item, ts: new Date().toISOString(), session }) + '\n')
    confirmed = true
  })
  return confirmed
}

// factory.ts registers the plan approval here (this module never imports factory.ts): called after a client's typed approve of a `run` item.
let planApprover: ((repo: string, dir: string, item: string) => Obj) | null = null
export function onPlanApprove(fn: (repo: string, dir: string, item: string) => Obj): void {
  planApprover = fn
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
  const noteGiven = textOf(f, 'note')
  const note = (noteGiven ?? '').slice(0, 4000)
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
  let planItem = false as boolean
  withLock(S, 'inbox', () => {
    const it = verifiedItems(repo).get(id)
    if (it === undefined) throw refuse({ error: `no such item: ${id}` })
    if (it.resolve !== null) throw refuse({ error: `${id} is already resolved` })
    const kind = String(it.open.kind)
    planItem = kind === 'client-trigger' && it.open.ref === 'run' && it.open.session === session
    firstCrew = it.crews[0] ?? 'main'
    if (by === 'pm' && KINDS[kind]?.by !== 'any') throw refuse({ error: `${kind} is resolved by the client, not by pm` })
    if (raiseUsd !== undefined && kind !== 'budget') throw refuse({ error: '--raise-usd is for the budget kind only' })
    if (codeHashOf(id, code) !== it.open.codeHash) throw refuse({ error: 'wrong code' })
    if (by === 'client') {
      const p = typedProof(repo, session, it.open, decision, raiseUsd)
      if ('missing' in p) {
        if (p.raiseTyped !== undefined) throw refuse({ error: `the client typed raise ${p.raiseTyped} for ${id}: pass --raise-usd ${p.raiseTyped}, a resolve without it cannot stand for a typed raise` })
        const line = `${decision} ${id} <code>${raiseUsd === undefined ? '' : ` raise ${raiseUsd}`}`
        const cfg = process.env.CLAUDE_CONFIG_DIR // read for this message only, never as a root
        const why = p.missing !== '' && cfg && flat(path.join(cfg, 'projects')) !== proofTranscriptRoot() ? `; CLAUDE_CONFIG_DIR is set to ${flat(cfg)} but the proof reads transcripts only under ${proofTranscriptRoot()}` : ''
        throw refuse({ error: `no prompt typed by the client resolves ${id}: the client types this as a plain prompt in this session: ${line}${why}` })
      }
      // a note the agent passes is the client's typed words after the code, or empty when none were typed
      if (noteGiven !== undefined && norm(note) !== p.rest.slice(0, 4000)) throw refuse({ error: `--note differs from what the client typed after the code (${p.rest === '' ? 'nothing' : JSON.stringify(p.rest.slice(0, 200))}): pass that text as the note, or none` })
      quote = p.quote
    }
    const op: Obj = { v: 1, op: 'resolve', id, ts: new Date().toISOString(), session, decision, by, note, quote }
    if (raiseUsd !== undefined) op.raiseUsd = raiseUsd
    appendFileSync(file, JSON.stringify(op) + '\n')
    // the resolving session may differ from the one that raised the item: its sidecar is under the open row's session
    const raised = String(it.open.session)
    if (SLUG_RE.test(raised)) {
      try {
        unlinkSync(codeFile(`${path.posix.dirname(S)}/${raised}`, id))
      } catch {
        // no sidecar, or it is already gone
      }
    }
  })
  event(dir, { event: 'resolve', crew: firstCrew, id, decision, by })
  const out: Obj = { id, state: 'resolved', decision, quote }
  // ADR-0045: the client's typed approve of this dir's plan-approval item approves the plan itself, outside the inbox lock. A refusal
  // (open long-term cost, already approved) leaves the resolve standing and rides in the output.
  if (by === 'client' && decision === 'approve' && planItem && planApprover !== null) {
    try {
      out.approved = planApprover(repo, dir, id)
    } catch (e) {
      if (!(e instanceof CliError)) throw e
      out.approveRefused = e.body
    }
  }
  return out
}

function markApplied(f: Flags): Obj {
  const repo = flat(need(f, 'repo'))
  const id = need(f, 'id')
  const session = sessionOf(need(f, 'dir'))
  const S = sharedDir(repo)
  const file = `${S}/inbox.jsonl`
  withLock(S, 'inbox', () => {
    const it = verifiedItems(repo).get(id)
    if (it === undefined) throw refuse({ error: `no such item: ${id}` })
    if (it.resolve === null) throw refuse({ error: `${id} is not resolved` })
    if (it.applied.includes(session)) return
    appendFileSync(file, JSON.stringify({ v: 1, op: 'applied', id, ts: new Date().toISOString(), session }) + '\n')
  })
  return { id }
}

function listItems(f: Flags): Obj {
  const repo = flat(need(f, 'repo'))
  if (f['recover-codes'] === true) return recoverCodes(repo)
  const dirFlag = str(f, 'dir')
  const sidFlag = f.unapplied === true ? str(f, 'session') : undefined
  const session = sidFlag ?? (dirFlag === undefined ? null : sessionOf(dirFlag))
  const kind = str(f, 'kind')
  const crew = str(f, 'crew')
  const all = verifiedItems(repo)
  const items: Obj[] = []
  let open = 0
  for (const [id, it] of all) {
    const state = it.resolve === null ? 'open' : 'resolved'
    if (state === 'open') open++
    const applied = session === null ? it.applied.length > 0 : it.applied.includes(session)
    if (f.open === true && state !== 'open') continue
    if (f.unapplied === true && (state !== 'resolved' || applied)) continue
    if (sidFlag !== undefined && it.open.session !== sidFlag) continue
    if (kind !== undefined && it.open.kind !== kind) continue
    if (crew !== undefined && !it.crews.includes(crew)) continue
    const row: Obj = { id, ts: it.open.ts, kind: it.open.kind, session: it.open.session, crews: it.crews, ref: it.open.ref ?? null, blocking: it.blocking, title: it.open.title, state }
    if (it.resolve !== null) {
      row.decision = it.resolve.decision
      row.by = it.resolve.by
      row.note = it.resolve.note
      row.quote = maskCode(it.resolve.quote ?? null, id, it.open.codeHash)
      if (it.resolve.raiseUsd !== undefined) row.raiseUsd = it.resolve.raiseUsd
      if (it.noteUnbound === true) row.noteUnbound = true
    } else if (it.reopened !== undefined) row.reopened = it.reopened
    row.applied = applied
    items.push(row)
  }
  return { items, open }
}

// The surviving codes of open items, from the escalate sidecars of every session dir under <common>/truss/. A code alone lifts nothing:
// a resolve still needs the typed line.
function recoverCodes(repo: string): Obj {
  const items = verifiedItems(repo)
  const root = path.posix.dirname(sharedDir(repo))
  const codes: Obj[] = []
  let sessions: string[] = []
  try {
    sessions = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'shared').map((d) => d.name).sort()
  } catch {
    // no session dirs yet
  }
  for (const session of sessions) {
    let names: string[] = []
    try {
      names = readdirSync(`${root}/${session}`).filter((n) => /^escalate-code-[A-Za-z0-9._-]+\.json$/.test(n)).sort()
    } catch {
      continue
    }
    for (const name of names) {
      try {
        const j = JSON.parse(readFileSync(`${root}/${session}/${name}`, 'utf8'))
        const it = items.get(j?.id)
        if (it !== undefined && it.resolve === null && typeof j.code === 'string' && codeHashOf(j.id, j.code) === it.open.codeHash) codes.push({ id: j.id, code: j.code, session })
      } catch {
        // a torn or foreign file is not a code
      }
    }
  }
  return { codes }
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

// Words, times and the page-local flags the move views share (ADR-0023 section 4). Nothing here reads the
// run store: the flags are what this page learnt from its own POSTs (a 401 token, a 409 ended).
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Intent, QuestionRequest, ReplyRequest, Request, RunState, TranscriptEntry } from '../../store/types.ts'

/** The goal box's id: Your move hands focus to it when no card is left to answer. */
export const GOAL_BOX_ID = 'goal-box'

const pad = (n: number) => String(n).padStart(2, '0')

/** HH:MM in the viewer's time zone, or '' for a missing or bad stamp. */
export function hhmm(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "2m", "1h 5m" or "just now" for the time between a stamp and now. */
export function ago(iso: string, now: number): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const m = Math.max(0, Math.floor((now - t) / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ${m % 60}m ago`
}

export const num = (n: number | null | undefined) => Number(n ?? 0).toLocaleString('en-US')

export function costText(usd: number | null | undefined): string {
  if (typeof usd !== 'number') return ''
  return '$' + usd.toFixed(Math.abs(usd) < 0.01 && usd !== 0 ? 4 : 2)
}

export const firstLine = (s: string | null | undefined) => (s ?? '').split('\n')[0]!.trim()

export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

export const CANT_REACH = "Can't reach the Truss session. Is truss ui still running?"
export const LINK_EXPIRED = 'Session link expired. Open the link truss ui printed again.'
export const SESSION_ENDED = 'The session has ended. Start the UI again to send more.'

/** The text of the `Session` status. */
export function sessionWords(state: RunState | null, stalled: boolean, expired: boolean): string {
  if (expired) return LINK_EXPIRED
  if (state === null) return stalled ? CANT_REACH : 'connecting'
  const s = state.session
  const n = s.backgroundTasks.length
  switch (s.status) {
    case 'idle':
      return 'idle'
    case 'running':
      return 'running'
    case 'waiting':
      return n > 0 ? `working (${plural(n, 'background task')})` : 'waiting for input'
    case 'ended':
      return 'ended'
    case 'error': {
      const line = firstLine(s.error)
      return line ? `error: ${line}` : 'error'
    }
    default:
      return String(s.status)
  }
}

export const INTENT_LABEL: Record<'goal' | 'add' | 'none', string> = {
  goal: 'New goal',
  add: 'Add to current goal',
  none: 'Message',
}
export const intentKey = (i: Intent | undefined): 'goal' | 'add' | 'none' => (i === 'goal' || i === 'add' ? i : 'none')

export const CANCEL_WORDS: Record<string, string> = {
  aborted: 'the request was aborted, so the session stopped waiting for an answer',
  superseded: 'it was replaced: the session started a turn on its own',
  ended: 'the session ended while the request was open',
}
export const cancelWords = (r: Request) => `Cancelled: ${CANCEL_WORDS[r.cancelReason ?? ''] ?? 'the request was cancelled'}.`

/** The article's accessible name: kept when the card is answered or cancelled. */
export function cardName(r: Request): string {
  if (r.kind === 'question') return `Question from Claude: ${r.questions[0]?.header ?? ''}`.trim()
  if (r.kind === 'permission') return `Permission request: ${r.toolName}`
  return r.approvalAsk === true ? 'Approval needed' : 'The PM replied'
}

/** What a settled card says: the cancel reason, or what was answered. `sent` is what this page posted. */
export function settledWords(r: Request, sent: AnswerBody | null): { head: string; lines: string[] } {
  if (r.status === 'cancelled') return { head: cancelWords(r), lines: [] }
  if (r.kind === 'question') {
    const answers = r.answers ?? (sent && 'answers' in sent ? sent.answers : null) ?? {}
    return {
      head: 'Answered.',
      lines: r.questions.map((q) => `${q.header}: ${answers[q.question] ?? '(no answer recorded)'}`),
    }
  }
  const decision = r.decision ?? (sent && 'decision' in sent ? sent.decision : null)
  const message = r.message || (sent && 'message' in sent ? sent.message : '') || ''
  const word =
    decision === 'allow' ? 'Approved.' : decision === 'deny' ? 'Denied.' : decision === 'message' ? 'Replied with a message.' : ''
  return { head: word ? `Answered. ${word}` : 'Answered.', lines: message ? [`Sent: ${message}`] : [] }
}

export type AnswerBody =
  | { answers: Record<string, string> }
  | { decision: 'allow' | 'deny'; message?: string }
  | { decision: 'message'; message: string }

/** A reply that came back while agents still run, with no error: nothing for the person to decide. */
export const replyWaitsOnAgents = (r: Request) => r.kind === 'reply' && r.backgroundTasks > 0 && !r.isError

/** The cards that ask the person something, oldest first. */
export function openCards(state: RunState | null): Request[] {
  if (state === null) return []
  return state.requests
    .filter((r) => r.status === 'open' && !replyWaitsOnAgents(r))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}

export const openQuestion = (state: RunState | null): QuestionRequest | null =>
  state?.requests.find((r): r is QuestionRequest => r.kind === 'question' && r.status === 'open') ?? null

// ---- page-local flags --------------------------------------------------------------------------------

export interface PageFlags {
  /** A POST answered 401 {"error": "token"}: the link is dead. */
  expired: boolean
  /** A POST answered 409 {"error": "ended"}. */
  ended: boolean
}

const NONE: PageFlags = { expired: false, ended: false }
let flags: PageFlags = NONE
const listeners = new Set<() => void>()

export function setPageFlag(key: keyof PageFlags): void {
  if (flags[key]) return
  flags = { ...flags, [key]: true }
  for (const fn of [...listeners]) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function usePageFlags(): PageFlags {
  return useSyncExternalStore(subscribe, () => flags, () => NONE)
}

/** Marks the page flags a POST result implies; true when it was one of them. */
export function noteResult(status: number, error: string | null): boolean {
  if (status === 401 && error === 'token') {
    setPageFlag('expired')
    return true
  }
  if (status === 409 && error === 'ended') {
    setPageFlag('ended')
    return false
  }
  return false
}

// ---- Reply preview -------------------------------------------------------------------------------------------
export const PREVIEW_MAX = 280

/** `text` as plain words: markdown syntax (emphasis, backticks, headings, list markers, quotes, link and image wrappers) removed. */
export function stripMarkdown(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/```[^\n]*\n?([\s\S]*?)(```|$)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]*([-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A plain-text preview of a PM message: markdown stripped, cut at a word boundary within `max` characters, with an ellipsis when cut. */
export function previewText(text: string | null | undefined, max = PREVIEW_MAX): string {
  const plain = stripMarkdown(text)
  if (plain.length <= max) return plain
  const head = plain.slice(0, max)
  const space = head.search(/\s\S*$/)
  const cut = space > max / 2 ? head.slice(0, space) : head
  return cut.replace(/[\s,;:.\-–]+$/, '') + '…'
}

// ---- send state (R-41, R-47): the 10 s and 30 s marks the composer and the cards share ------------------

export const STILL_SENDING = 'Still sending…'
export const NOT_TAKEN = "The session hasn't taken the message. Try again, or reload if it keeps happening."
export const notSent = (reason: string) => `Not sent: ${reason}. Your text is still here.`
export const CARD_OPEN_HINT = 'The PM is waiting on the card above; a message here is sent as well.'
export const WORKING_STATUS = 'The PM is working on it.'

export type SendStage = 'idle' | 'sending' | 'slow' | 'stuck' | 'failed'
export const SLOW_MS = 10_000
export const STUCK_MS = 30_000

/** Where a send stands: `failed` wins, no start is idle, else the 10 s and 30 s marks. */
export function sendStage(startedAt: number | null, now: number, failed: boolean): SendStage {
  if (failed) return 'failed'
  if (startedAt === null) return 'idle'
  const t = now - startedAt
  return t >= STUCK_MS ? 'stuck' : t >= SLOW_MS ? 'slow' : 'sending'
}

/** The stage of a send that is under way (`active`) or has failed, re-evaluated at the 10 s and 30 s marks. */
export function useSendState(active: boolean, failed = false): SendStage {
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) {
      setStartedAt(null)
      return
    }
    const t0 = Date.now()
    setStartedAt(t0)
    setNow(t0)
    const a = setTimeout(() => setNow(Date.now()), SLOW_MS)
    const b = setTimeout(() => setNow(Date.now()), STUCK_MS)
    return () => {
      clearTimeout(a)
      clearTimeout(b)
    }
  }, [active])
  return sendStage(startedAt, now, failed)
}

/** The `n` of the assistant or error entry a reply request answers: the last one at or before it, else the last one. */
export function replyTarget(transcript: TranscriptEntry[], request: ReplyRequest): number | null {
  const at = Date.parse(request.createdAt)
  let before: number | null = null
  let last: number | null = null
  for (const e of transcript) {
    if (e.role !== 'assistant' && e.role !== 'error') continue
    last = e.n
    if (Date.parse(e.ts) <= at) before = e.n
  }
  return before ?? last
}

// ---- Read in thread ----------------------------------------------------------------------------------------

export const REVEAL_EVENT = 'truss:reveal-message'

/** Asks the thread to scroll to message `n` and focus it. */
export function revealMessage(n: number): void {
  window.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: { n } }))
}

/** "Not sent: <reason>." reason: the server's error string, else its HTTP status, else the network word. */
export function reasonOf(status: number, error: string | null): string {
  if (status === 0 && error === 'timeout') return 'the server did not answer in time'
  if (status === 0) return 'could not reach the server'
  if (error && error !== 'http') return error
  return `the server answered ${status}`
}

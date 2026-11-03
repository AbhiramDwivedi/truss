// Words, times and the page-local flags the move views share (ADR-0023 section 4). Nothing here reads the
// run store: the flags are what this page learnt from its own POSTs (a 401 token, a 409 ended).
import { useSyncExternalStore } from 'react'
import type { Intent, QuestionRequest, Request, RunState } from '../../store/types.ts'

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
  return 'Reply needed'
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

/** "Not sent: <reason>." reason: the server's error string, else its HTTP status, else the network word. */
export function reasonOf(status: number, error: string | null): string {
  if (status === 0 && error === 'timeout') return 'the server did not answer in time'
  if (status === 0) return 'could not reach the server'
  if (error && error !== 'http') return error
  return `the server answered ${status}`
}

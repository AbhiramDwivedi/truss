// The thread's data (ADR-0028 section 7, UX direction section 2): transcript entries, the PM's hand-offs and the
// queued messages merged into one list in time order. Pure, so the order and grouping rules are tested without a DOM.
import type { FlowEntry, QueuedMessage, TranscriptEntry } from '../../store/types.ts'

/** Items shown at first, and added by each "Show earlier messages". */
export const PAGE = 50

/** Messages from one sender closer than this share one avatar and name. */
const GROUP_MS = 2 * 60_000

export type ThreadItem =
  | { kind: 'message'; key: string; at: string; entry: TranscriptEntry }
  | { kind: 'system'; key: string; at: string; entry: FlowEntry; text: string }
  | { kind: 'queued'; key: string; at: string; message: QueuedMessage }

export function systemText(f: FlowEntry): string {
  return f.to ? `PM → crew ${f.to}: ${f.summary}` : `PM: ${f.summary}`
}

const time = (iso: string) => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

export function mergeThread(transcript: TranscriptEntry[], flow: FlowEntry[], queue: QueuedMessage[]): ThreadItem[] {
  const seen = new Set(transcript.map((e) => e.id).filter((id): id is string => !!id))
  const dup = new Map<string, number>()
  const timed: ThreadItem[] = [
    ...transcript.map((entry): ThreadItem => ({ kind: 'message', key: `m${entry.n}`, at: entry.ts, entry })),
    ...flow.map((entry): ThreadItem => {
      const base = `s${entry.at}`
      const i = dup.get(base) ?? 0
      dup.set(base, i + 1)
      return { kind: 'system', key: `${base}#${i}`, at: entry.at, entry, text: systemText(entry) }
    }),
  ]
  // Array.prototype.sort is stable, so equal times keep messages before hand-offs.
  timed.sort((a, b) => time(a.at) - time(b.at))
  const waiting = queue
    .filter((q) => !seen.has(q.id))
    .map((message): ThreadItem => ({ kind: 'queued', key: `q${message.id}`, at: message.at, message }))
  return [...timed, ...waiting]
}

export function isGrouped(prev: ThreadItem | undefined, cur: ThreadItem): boolean {
  if (!prev || prev.kind !== 'message' || cur.kind !== 'message') return false
  if (prev.entry.role !== cur.entry.role || cur.entry.role === 'error') return false
  return time(cur.at) - time(prev.at) <= GROUP_MS
}

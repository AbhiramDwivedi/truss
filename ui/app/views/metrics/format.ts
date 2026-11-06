// Formatters for Run metrics (ADR-0028 section 8). Pure, no React.
import type { RunState } from '../../store/types.ts'
import { runStatus } from '../status/status.ts'

const MIN = 60_000
const NUM = new Intl.NumberFormat('en-US')
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** 0m, 42m, 3h 05m, 2d 4h. */
export function formatRunTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / MIN))
  if (total < 60) return `${total}m`
  const hours = Math.floor(total / 60)
  if (hours < 24) return `${hours}h ${String(total % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** A session is hosted when the server has a sessionId for it (ADR-0029 section 4). */
export const isHosted = (state: RunState): boolean => state.session.sessionId != null

/** Start of the run from the first decisions[].run heading ("<RFC 3339> | goal"), as ms, or null. */
function headingStartMs(state: RunState): number | null {
  const heading = state.decisions.find((d) => d.run)?.run
  if (!heading) return null
  const t = Date.parse(heading.split(' | ')[0]!)
  return Number.isNaN(t) ? null : t
}

/** Latest parseable ts across every crew's foreman and members, or null. */
function lastActivityMs(state: RunState): number | null {
  let latest: number | null = null
  for (const c of state.run?.crews ?? []) {
    for (const m of c.foreman ? [c.foreman, ...c.members] : c.members) {
      const t = Date.parse(m.ts ?? '')
      if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t
    }
  }
  return latest
}

/** Run time in ms. With a transcript: first entry to now, or to the last entry once finished. With none: the first
 *  run heading to now (hosted and working) or to the latest crew ts (ADR-0029 section 4). Null with neither. */
export function runTimeMs(state: RunState, now: number): number | null {
  const first = Date.parse(state.transcript[0]?.ts ?? '')
  if (!Number.isNaN(first)) {
    let end = now
    if (runStatus(state) === 'finished') {
      const last = Date.parse(state.transcript.at(-1)?.ts ?? '')
      if (!Number.isNaN(last)) end = last
    }
    return Math.max(0, end - first)
  }
  if (state.transcript.length > 0) return null
  const start = headingStartMs(state)
  if (start === null) return null
  const live = isHosted(state) && runStatus(state) !== 'finished'
  const end = live ? now : (lastActivityMs(state) ?? start)
  return Math.max(0, end - start)
}

/** Start and end stamps (ms) of the heading fallback, for the tile sub-line; null when the transcript is used or absent. */
export function headingSpan(state: RunState): { start: number; end: number | null; live: boolean } | null {
  if (state.transcript.length > 0) return null
  const start = headingStartMs(state)
  if (start === null) return null
  return { start, end: lastActivityMs(state) ?? start, live: isHosted(state) && runStatus(state) !== 'finished' }
}

/** A run exists: run.json, or any decisions[] entry with a run heading. */
const hasRun = (state: RunState): boolean => state.run !== null || state.decisions.some((d) => !!d.run)

/** usage: a cost figure. not-recorded: a run with no cost and no transcript. none: everything else. */
export function costState(state: RunState): 'usage' | 'not-recorded' | 'none' {
  if (typeof state.session.usage?.costUsd === 'number') return 'usage'
  // A hosted run may still receive usage, so it reads "No usage yet" rather than "Not recorded".
  if (hasRun(state) && state.transcript.length === 0 && !isHosted(state)) return 'not-recorded'
  return 'none'
}

export const formatUsd = (n: number): string => USD.format(n)

export const formatCount = (n: number | null | undefined): string => (n == null ? '—' : NUM.format(n))

/** hh:mm in the viewer's zone, or null for a stamp that does not parse. */
export function clockOf(iso: string | null | undefined): string | null {
  const t = Date.parse(iso ?? '')
  if (Number.isNaN(t)) return null
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

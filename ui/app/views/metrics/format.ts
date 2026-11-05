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

/** Run time in ms: first transcript entry to now, or to the last entry once finished. Null with no transcript. */
export function runTimeMs(state: RunState, now: number): number | null {
  const first = Date.parse(state.transcript[0]?.ts ?? '')
  if (Number.isNaN(first)) return null
  let end = now
  if (runStatus(state) === 'finished') {
    const last = Date.parse(state.transcript.at(-1)?.ts ?? '')
    if (!Number.isNaN(last)) end = last
  }
  return Math.max(0, end - first)
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

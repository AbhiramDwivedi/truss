// Pure helpers the floor views share: times in the viewer's zone, durations, token counts, and the crew
// wording ADR-0018 section 10 and ADR-0023 section 4 pin. No React, no window, no document.
import type { Crew, CrewStuck, Member } from '../../store/types.ts'

const pad = (n: number) => String(n).padStart(2, '0')

/** HH:MM, 24-hour, in the viewer's time zone; '' for a missing or bad stamp. */
export function hhmm(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** HH:MM for a millisecond epoch, in the viewer's time zone. */
export function hhmmAt(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `Thu 22:37`: the short English weekday and HH:MM, in the viewer's time zone. */
export function dayTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(d)
  return `${day} ${hhmm(iso)}`
}

export const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

/** `11h 53m 59s`, `7m 02s`, `40s`. Negative spans read as zero. */
export function clock(span: number): string {
  const s = Math.max(0, Math.floor(span / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${pad(m)}m ${pad(sec)}s`
  if (m > 0) return `${m}m ${pad(sec)}s`
  return `${sec}s`
}

/** `7m`, `2h 05m`, `40s`: a short span with no seconds once it passes a minute. */
export function short(span: number): string {
  const s = Math.max(0, Math.floor(span / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${pad(m)}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}

/** `updated 12s ago`, `updated 3m ago`. */
export function ago(span: number): string {
  const s = Math.max(0, Math.floor(span / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

export const exact = (n: number) => Math.round(n).toLocaleString('en-US')

/** Separators up to 10 M, then compact (`12.4M`); `exact` stays for the title. */
export function tokens(n: number): string {
  if (n >= 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return exact(n)
}

/** `2.1k` above a thousand, else a whole number. */
export function rate(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

// ---- crews --------------------------------------------------------------------------------------------

/** Members whose work is under way, done, or silent. */
export const LIVE_STATES: ReadonlySet<Member['state']> = new Set(['spawned', 'tagged', 'fetched'])
export const DONE_STATES: ReadonlySet<Member['state']> = new Set(['reported'])
export const FAILED_STATES: ReadonlySet<Member['state']> = new Set(['stalled', 'allowance-spent'])

export const statusWord = (c: Crew): string => c.status ?? 'status unknown'

/** The stalled agent's name: the crew's stalled member, else the first word of stuck.detail. */
export function stalledAgent(c: Crew): string {
  const m = c.members.find((x) => x.state === 'stalled')
  if (m) return m.name
  const first = (c.stuck?.detail ?? '').trim().split(/\s+/)[0]
  return first || c.slug
}

/** The last hyphen segment of the stalled agent's name (`quota-api-builder` gives `builder`). */
export function stalledRole(c: Crew): string {
  const name = stalledAgent(c)
  const seg = name.split('-').filter(Boolean)
  return seg.at(-1) ?? 'agent'
}

export function stuckWords(s: CrewStuck): string {
  return s.kind === 'idle-foreman' ? `stuck: foreman idle ${s.minutes} min` : `stuck: stalled ${s.minutes} min`
}

/** ADR-0018 section 10's blocked reason in words, for a crew with no stuck record. */
export function blockedWords(c: Crew): string | null {
  if (c.stuck) return null
  if (c.qc?.verdict === 'FAIL') return 'blocked: QC FAIL'
  const stalled = c.members.find((m) => m.state === 'stalled')
  if (stalled) return `blocked: stalled ${stalled.detail ?? ''}`.trim()
  if (c.latest?.event === 'report' && /\bBLOCKED\b/.test(c.latest.text)) return 'blocked: reported BLOCKED'
  return null
}

/** The crew button's accessible name: slug, stage, status, verdict, QC, agents planned, latest, stuck or blocked. */
export function crewName(c: Crew): string {
  const parts = [
    c.slug,
    c.stage === null ? 'no stage' : `stage ${c.stage}`,
    statusWord(c),
    c.verdict ?? 'no verdict',
    `QC ${c.qc?.verdict ?? 'none'}`,
  ]
  if (c.estAgents != null) parts.push(`${c.estAgents} agents planned`)
  if (c.latest?.text) parts.push(`latest: ${c.latest.text}`)
  if (c.stuck) parts.push(stuckWords(c.stuck))
  const blocked = blockedWords(c)
  if (blocked) parts.push(blocked)
  return parts.join(', ')
}

/**
 * The words of crewName the crew button does not show: they follow its visible text in a screen-reader-only
 * span, so the accessible name starts with the visible words (WCAG 2.5.3, axe label-content-name-mismatch).
 */
export function crewNameExtra(c: Crew): string {
  const parts = [c.stage === null ? 'no stage' : `stage ${c.stage}`, statusWord(c)]
  if (!c.verdict) parts.push('no verdict')
  if (c.latest?.text) parts.push(`latest: ${c.latest.text}`)
  if (c.stuck) parts.push(stuckWords(c.stuck))
  const blocked = blockedWords(c)
  if (blocked) parts.push(blocked)
  return parts.join(', ')
}

/** When the crew started: its foreman's spawn, else its earliest member. */
export function crewStart(c: Crew): number | null {
  const stamps = [c.foreman?.ts, ...c.members.map((m) => m.ts)].map(ms).filter((x): x is number => x !== null)
  return stamps.length ? Math.min(...stamps) : null
}

/** When a merged crew ended: its latest activity. */
export const crewEnd = (c: Crew): number | null => ms(c.latest?.ts)

/** The stuck record's flag time: since plus minutes (ADR-0023 gap g). */
export function flaggedAt(s: CrewStuck): number | null {
  const t = ms(s.since)
  return t === null ? null : t + s.minutes * 60_000
}

/** A stall's minutes from a member's detail (`15 min`). */
export function detailMinutes(detail: string | null): number | null {
  const m = /(\d+)/.exec(detail ?? '')
  return m ? Number(m[1]) : null
}

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

/** `opus`, `sonnet`, the raw model id, or null when the model is unknown (the card then shows no badge). */
export const modelKey = (m: string | null): string | null => (m && /opus/i.test(m) ? 'opus' : m && /sonnet/i.test(m) ? 'sonnet' : m || null)

const NAME_ROLES: ReadonlySet<string> = new Set(['builder', 'tester', 'writer', 'runner', 'planner', 'ux'])
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The role word in an agent name: its last segment, else the last earlier segment that is a role (`quotas-builder-cf12108d`). */
function nameRole(name: string): string | null {
  const segs = name.split('-').filter(Boolean).map((x) => x.toLowerCase())
  if (segs.length < 2) return null
  const last = segs.at(-1)!
  if (NAME_ROLES.has(last) || ROLE_ORDER.includes(last)) return last
  return [...segs.slice(1)].reverse().find((x) => NAME_ROLES.has(x) || ROLE_ORDER.includes(x)) ?? null
}

/** The role a non-truss agent type names by its last segment (`kit:builder`, `kit:test-writer`), else null. */
const TYPE_ROLES: Readonly<Record<string, string>> = { builder: 'builder', tester: 'tester', 'test-writer': 'tester', writer: 'writer', reviewer: 'reviewer', scout: 'scout' }
function typeRole(type: string | null | undefined): string | null {
  if (!type || type.startsWith('truss:')) return null
  return TYPE_ROLES[type.split(':').at(-1)!.toLowerCase()] ?? null
}

/** The agent card's role word (ADR-0028 section 6). */
export function roleWord(m: Pick<Member, 'type' | 'name'>): string {
  const type = m.type ?? ''
  if (type === 'truss:project-manager' || type === 'workflow-crew') return 'Foreman'
  if (type === 'truss:qc-engineer') return 'QC engineer'
  if (type === 'truss:foreman') return 'General purpose' // ADR-0042: the retired type is no longer read as a crew lead
  if (type.startsWith('truss:')) return sentence(type.slice(6).replace(/-/g, ' '))
  const typed = typeRole(m.type)
  if (typed !== null) return sentence(typed)
  const role = nameRole(m.name)
  return role !== null && NAME_ROLES.has(role) ? sentence(role) : 'General purpose'
}

export const RUNNER_PURPOSE = 'Runs one check command for the crew.'

/**
 * A runner or an untyped general-purpose agent: it runs one check command for the crew. An agent with a real type
 * (`kit:builder`, `truss:*`) is never a check run.
 */
export function isCheckRun(m: Pick<Member, 'type' | 'name'>): boolean {
  const type = m.type ?? ''
  if (type === 'workflow-crew' || type.startsWith('truss:') || typeRole(type) !== null) return false
  const role = nameRole(m.name)
  if (role === 'runner') return true
  return (type === '' || type === 'general-purpose') && (role === null || !(NAME_ROLES.has(role) || ROLE_ORDER.includes(role)))
}

const ROLE_ORDER = ['builder', 'tester', 'ux', 'qc', 'stress', 'planning', 'writer', 'resolver']

/**
 * The member list order: foreman first, then the named truss roles (builder, tester, ux, qc, stress, planning,
 * writer, resolver), then the rest; check runs last, split off by the caller.
 */
export function orderAgents(agents: readonly Member[], foreman: Member | null): Member[] {
  const rank = (m: Member): number => {
    if (foreman ? m === foreman || m.name === foreman.name : false) return 0
    if (m.type === 'truss:project-manager' || m.type === 'workflow-crew') return 0
    const key = (m.type ?? '').startsWith('truss:') ? m.type!.slice(6).split('-')[0]! : (typeRole(m.type) ?? nameRole(m.name) ?? '')
    const i = ROLE_ORDER.indexOf(key)
    return i >= 0 ? i + 1 : ROLE_ORDER.length + 1
  }
  return agents.map((m, i) => ({ m, i, r: rank(m) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.m)
}

const MARKER_DETAILS: ReadonlySet<string> = new Set(['working', 'idle', 'spawned', 'tagged', 'fetched', 'reported', 'done'])

const BARE_MARKERS: ReadonlySet<string> = new Set([...MARKER_DETAILS, 'question', 'blocked', 'proposal'])

export const REPORTED = 'Reported'
export const REPORTED_PREFIX = 'Reported: '
export const NO_TASK = 'No task recorded'
export const NO_ACTIVITY = 'No activity yet'

/** The crew's goal text, first line: crew.goal is a goal id (text in older runs); an id resolves through `goals`, never shows bare. */
export function crewGoalText(crew: Pick<Crew, 'goal'>, goals: readonly { id: string; goal: string | null }[]): string | null {
  const listed = crew.goal === null ? goals[0] : goals.find((g) => g.id === crew.goal)
  const raw = listed !== undefined ? listed.goal : crew.goal
  const first = raw?.split('\n').find((l) => l.trim() !== '')?.trim()
  return first || null
}

/**
 * The one task line: the task, else the foreman's crew goal, else a detail that is not a bare marker, else for a
 * reported agent `Reported: <MARKER>` or `Reported`, else null (the card words the empty case).
 */
export function taskLine(m: Member, crew: Pick<Crew, 'goal' | 'foreman'>, goals: readonly { id: string; goal: string | null }[] = []): string | null {
  if (m.task) return m.task
  const isForeman = m.type === 'truss:project-manager' || m.type === 'workflow-crew' || crew.foreman === m
  if (isForeman) {
    const g = crewGoalText(crew, goals)
    if (g) return g
  }
  const d = m.detail?.trim()
  if (d && !BARE_MARKERS.has(d.toLowerCase())) return d
  if (m.state === 'reported') return d ? REPORTED_PREFIX + d.toUpperCase() : REPORTED
  return null
}

/** 3 once reported or in a merged or dropped crew, 1 while spawned with no detail and no task, else 2. */
export function stepOf(m: Member, crew?: Pick<Crew, 'status'>): 1 | 2 | 3 {
  if (crew && (crew.status === 'merged' || crew.status === 'dropped')) return 3
  if (m.state === 'reported') return 3
  if (m.state === 'spawned' && !m.detail && !m.task) return 1
  return 2
}

export const statusWord =(c: Crew): string => c.status ?? 'status unknown'

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

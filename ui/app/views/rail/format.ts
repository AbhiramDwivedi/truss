// Small formatters the library views share. Pure: no window, no document, no store.
import type { Crew, DesignImage, RunState } from '../../store/types.ts'

const pad = (n: number) => String(n).padStart(2, '0')

/** HH:MM, 24-hour, in the viewer's zone; '' for a missing or unreadable stamp. */
export function hhmm(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Milliseconds since the epoch, or null. */
export function stamp(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

/** "3m ago", "2h 5m ago", "just now" from two stamps. */
export function ago(iso: string | null | undefined, now: number): string {
  const t = stamp(iso)
  if (t === null) return ''
  const m = Math.max(0, Math.floor((now - t) / 60000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ${m % 60}m ago`
}

/** First letter upper case, the rest as given. */
export function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}

/** The file name at the end of a path. */
export function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

/** The /api/image URL for an image a crew branch holds (ADR-0011 Decision 7). */
export function imageUrl(img: DesignImage): string {
  return '/api/image?' + new URLSearchParams({ ref: img.ref, path: img.path }).toString()
}

/** The crew whose branch an image ref names (`truss-<slug>`), or null. */
export function crewOfRef(state: RunState, ref: string): Crew | null {
  const crews = state.run?.crews ?? []
  return crews.find((c) => ref === `truss-${c.slug}`) ?? crews.find((c) => ref.endsWith(c.slug)) ?? null
}

/** The run's first goal (id run, gap d), falling back to the run's own fields. */
export function firstGoal(state: RunState | null): { goal: string | null; approval: 'auto' | 'client' | null; approvedAt: string | null } | null {
  const run = state?.run
  if (!run) return null
  const g = run.goals?.[0]
  return {
    goal: g?.goal ?? run.goal,
    approval: g?.approval ?? run.approval,
    approvedAt: g?.approvedAt ?? run.approvedAt,
  }
}

/** "Approved by you at HH:MM" or "Approved automatically at HH:MM"; null before approval. */
export function approvalLine(state: RunState | null): string | null {
  const g = firstGoal(state)
  if (!g || !g.approvedAt) return null
  const t = hhmm(g.approvedAt)
  return g.approval === 'auto' ? `Approved automatically at ${t}` : `Approved by you at ${t}`
}

/** The model family a model id names, for ModelBadge's dot. */
export function family(model: string): 'opus' | 'sonnet' | string {
  return /opus/i.test(model) ? 'opus' : /sonnet/i.test(model) ? 'sonnet' : model
}

/** "$1.24", or null when no cost is known yet. */
export function money(cost: number | null | undefined): string | null {
  return typeof cost === 'number' ? `$${cost.toFixed(2)}` : null
}

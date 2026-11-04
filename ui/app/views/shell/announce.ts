// What the polite announcer says when crew statuses change between two snapshots (R-44). Pure, no React.
import type { RunState } from '../../store/types.ts'
import { crewStatus, STATUS_WORD } from '../status/status.ts'

/** "Crew <slug> is now <word>" per changed crew, in crew order, joined with "; ". Empty with no previous snapshot. */
export function crewAnnouncement(prev: RunState | null, next: RunState | null): string {
  if (!prev || !next) return ''
  const before = new Map((prev.run?.crews ?? []).map((c) => [c.slug, crewStatus(c)]))
  const parts: string[] = []
  for (const c of next.run?.crews ?? []) {
    const was = before.get(c.slug)
    const now = crewStatus(c)
    if (was !== undefined && was !== now) parts.push(`Crew ${c.slug} is now ${STATUS_WORD[now].toLowerCase()}`)
  }
  return parts.join('; ')
}

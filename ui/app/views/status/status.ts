// The shared status vocabulary (ADR-0028 section 9, R-44). Pure rules, no React: every view that shows
// a status word reads it from here, so one state never carries two names.
import type { Crew, Member, RunState } from '../../store/types.ts'

export type Status = 'active' | 'done' | 'waiting' | 'stuck' | 'planned'
export type RunStatus = 'not-started' | 'working' | 'waiting' | 'finished'

export const STATUS_WORD: Record<Status, string> = {
  active: 'Active',
  done: 'Done',
  waiting: 'Waiting on you',
  stuck: 'Stuck',
  planned: 'Planned',
}

export const RUN_STATUS_WORD: Record<RunStatus, string> = {
  'not-started': 'Not started',
  working: 'Working',
  waiting: 'Waiting on you',
  finished: 'Finished',
}

const ASKS = /^\s*(QUESTION|BLOCKED|PROPOSAL)\b/

/** True when a detail line opens with a marker that needs the client's answer. */
const asks = (detail: string | null | undefined): boolean => detail != null && ASKS.test(detail)

/** Merged and dropped first, then stuck, then a foreman ask, then running; planned last. */
export function crewStatus(crew: Crew): Status {
  if (crew.status === 'merged' || crew.status === 'dropped') return 'done'
  if (crew.stuck) return 'stuck'
  if (crew.status === 'running') return asks(crew.foreman?.detail) ? 'waiting' : 'active'
  if (crew.status === 'planned') return 'planned'
  if (crew.status === null && crew.members.length === 0) return 'planned'
  return 'active'
}

/** An agent never contradicts its crew: a merged or dropped crew makes every agent Done, then the member's own state. */
export function agentStatus(member: Member, crew: Pick<Crew, 'status'>): Status {
  if (crew.status === 'merged' || crew.status === 'dropped') return 'done'
  if (member.state === 'reported') return 'done'
  if (member.state === 'stalled' || member.state === 'allowance-spent') return 'stuck'
  if (asks(member.detail)) return 'waiting'
  return 'active'
}

/** An open request always waits on the client; a waiting session with background tasks still running is Working. */
const isWaiting = (s: RunState): boolean =>
  s.requests.some((q) => q.status === 'open') || (s.session.status === 'waiting' && s.session.backgroundTasks.length === 0)
const allCrewsDone = (s: RunState): boolean => {
  const crews = s.run?.crews ?? []
  return crews.length > 0 && crews.every((c) => c.status === 'merged' || c.status === 'dropped')
}
const noPlan = (s: RunState): boolean => s.run === null && s.transcript.length === 0

/** The PM node: Planned before any run, Waiting on an ask, Done once every crew is, else Active. */
export function pmStatus(s: RunState): Status {
  if (noPlan(s)) return 'planned'
  if (isWaiting(s)) return 'waiting'
  if (allCrewsDone(s) && s.session.status !== 'running') return 'done'
  return 'active'
}

export function runStatus(s: RunState): RunStatus {
  if (noPlan(s)) return 'not-started'
  if (isWaiting(s)) return 'waiting'
  if (allCrewsDone(s) && s.session.status !== 'running') return 'finished'
  return 'working'
}

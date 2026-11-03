// What the person has sent, newest first (ADR-0023 section 4): the transcript's user lines plus the
// queue the SDK has not taken yet. A message in both shows once, as Queued.
import { useId } from 'react'
import type { Intent, RunState } from '../../store/types.ts'
import { FollowUpRow } from './FollowUpRow.tsx'

export interface FollowUpsProps {
  state: RunState | null
  now: number
}

interface Row {
  key: string
  text: string
  intent: Intent | undefined
  at: string
  queued: boolean
}

function rowsOf(state: RunState | null): Row[] {
  if (state === null) return []
  const queue = state.session.queue ?? []
  const queued = new Set(queue.map((m) => m.id))
  const rows: Row[] = []
  const listed = new Set<string>()
  for (const e of state.transcript) {
    if (e.role !== 'user') continue
    const id = e.id ?? null
    if (id !== null) listed.add(id)
    rows.push({ key: id ?? `n-${e.n}`, text: e.text, intent: e.intent, at: e.ts, queued: id !== null && queued.has(id) })
  }
  for (const m of queue) {
    if (listed.has(m.id)) continue
    rows.push({ key: m.id, text: m.text, intent: m.intent, at: m.at, queued: true })
  }
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Date.parse(b.r.at) - Date.parse(a.r.at) || b.i - a.i)
    .map(({ r }) => r)
}

export function FollowUps({ state }: FollowUpsProps) {
  const titleId = useId()
  const rows = rowsOf(state)
  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-1">
      <h3 id={titleId} className="text-meta font-semibold text-fg">
        Follow-ups
      </h3>
      {rows.length === 0 ? (
        <p className="text-meta text-muted">Nothing sent yet.</p>
      ) : (
        <ul className="flex min-w-0 flex-col divide-y divide-border">
          {rows.map((r) => (
            <FollowUpRow key={r.key} text={r.text} intent={r.intent} at={r.at} queued={r.queued} />
          ))}
        </ul>
      )}
    </section>
  )
}

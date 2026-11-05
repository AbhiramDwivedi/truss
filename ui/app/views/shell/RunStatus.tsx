// The server's notices and the stream's own state, as one polite list (ADR-0023 section 4). Each item
// reads "Status: <text>"; the list is always there, so screen readers hear items arrive.
import type { Connection, RunState } from '../../store/types.ts'
import { Dot } from '../../components/ui/dot.tsx'

export interface RunStatusProps {
  state: RunState | null
  now: number
  /** The stream link; reconnecting adds a "Reconnecting…" item until it recovers. */
  connection?: Connection
  /** The Reload notice stands in for the "Reconnecting…" item, so the header keeps the height it had. */
  replacesReconnecting?: boolean
}

export function RunStatus({ state, connection, replacesReconnecting }: RunStatusProps) {
  const items: { id: string; text: string }[] = []
  if (connection === 'reconnecting' && !replacesReconnecting) items.push({ id: 'stream-reconnecting', text: 'Reconnecting…' })
  for (const n of state?.notices ?? []) {
    if (connection === 'reconnecting' && n.text === 'Reconnecting…') continue
    items.push(n)
  }
  return (
    <ul aria-label="Run status" aria-live="polite" className="flex min-w-0 flex-col gap-1 empty:hidden">
      {items.map((n) => (
        <li key={n.id} className="flex min-w-0 items-start gap-2 rounded-ctl bg-signal-soft px-3 py-2 text-ui text-signal-text">
          <Dot tone="signal" className="mt-2" />
          <span className="min-w-0 break-words">
            <span className="sr-only">Status: </span>
            {n.text}
          </span>
        </li>
      ))}
    </ul>
  )
}

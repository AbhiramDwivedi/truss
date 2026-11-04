// A hand-off from the PM to a crew (R-40): a quiet centred line, not a bubble. The summary is never truncated.
import { Workflow } from 'lucide-react'
import type { FlowEntry } from '../../store/types.ts'
import { hhmm } from '../rail/format.ts'

export function SystemLine({ entry }: { entry: FlowEntry }) {
  const t = hhmm(entry.at)
  return (
    <p className="flex min-w-0 flex-wrap items-center justify-center gap-x-2 text-center text-meta text-muted [overflow-wrap:anywhere]">
      <Workflow aria-hidden="true" className="size-3.5 shrink-0 text-subtle" />
      {entry.to ? (
        <span>
          PM → crew <span className="font-mono">{entry.to}</span>: {entry.summary}
        </span>
      ) : (
        <span>PM: {entry.summary}</span>
      )}
      {t && <span className="font-mono text-micro tabular-nums text-subtle">{t}</span>}
    </p>
  )
}

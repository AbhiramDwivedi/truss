// One sent or queued message (ADR-0023 section 4): an intent icon and label, the text on one line with
// an ellipsis, and one chip, Queued or Sent HH:MM. The text takes focus and names its whole self, so
// keyboard and touch users reach a long message, not only a hover title.
import { ListPlus, MessageSquare, Target } from 'lucide-react'
import type { Intent } from '../../store/types.ts'
import { Badge } from '../../components/ui/badge.tsx'
import { INTENT_LABEL, hhmm, intentKey } from '../move/format.ts'

export interface FollowUpRowProps {
  text: string
  intent: Intent | undefined
  /** When it was sent or accepted. */
  at: string
  queued: boolean
}

const ICON = { goal: Target, add: ListPlus, none: MessageSquare } as const

export function FollowUpRow({ text, intent, at, queued }: FollowUpRowProps) {
  const key = intentKey(intent)
  const Icon = ICON[key]
  const time = hhmm(at)
  return (
    <li className="flex min-w-0 items-center gap-3 py-2">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-meta font-medium text-muted">{INTENT_LABEL[key]}</span>
        <span
          role="note"
          tabIndex={0}
          title={text}
          aria-label={text}
          className="block min-w-0 truncate rounded-chip text-ui whitespace-nowrap text-fg"
        >
          {text}
        </span>
      </div>
      {queued ? (
        <span className="inline-flex h-6 shrink-0 items-center rounded-chip bg-signal-soft px-2.5 text-meta font-medium text-signal-text">
          Queued
        </span>
      ) : (
        <Badge tone="neutral" className="shrink-0 font-mono">
          {time ? `Sent ${time}` : 'Sent'}
        </Badge>
      )}
    </li>
  )
}

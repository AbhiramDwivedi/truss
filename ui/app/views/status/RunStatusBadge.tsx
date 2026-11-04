// The run-level status (ADR-0028 section 9): Not started, Working, Waiting on you, Finished. Word and
// icon share one element, as in StatusBadge.
import * as React from 'react'
import { CircleCheck, CircleDashed, Hand } from 'lucide-react'
import { Badge, type BadgeTone } from '../../components/ui/badge.tsx'
import { ActiveIcon } from './StatusBadge.tsx'
import { RUN_STATUS_WORD, type RunStatus } from './status.ts'

export interface RunStatusBadgeProps {
  status: RunStatus
  size?: 'sm' | 'md'
}

const TONE: Record<RunStatus, BadgeTone> = { 'not-started': 'neutral', working: 'brand', waiting: 'signal', finished: 'ok' }

function Icon({ status }: { status: RunStatus }) {
  switch (status) {
    case 'working': return <ActiveIcon />
    case 'waiting': return <Hand aria-hidden="true" className="size-3.5 shrink-0" />
    case 'finished': return <CircleCheck aria-hidden="true" className="size-3.5 shrink-0 text-ok" />
    case 'not-started': return <CircleDashed aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
  }
}

export function RunStatusBadge({ status, size = 'md' }: RunStatusBadgeProps) {
  return (
    <Badge tone={TONE[status]} size={size}>
      <span className="inline-flex items-center gap-1">
        <Icon status={status} />
        <span>{RUN_STATUS_WORD[status]}</span>
      </span>
    </Badge>
  )
}

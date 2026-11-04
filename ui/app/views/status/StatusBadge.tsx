// The one word-plus-icon status every view uses (ADR-0028 section 9, R-44). The icon and the word sit in
// the same element, so colour is never the only cue. Active's icon is a LivePing-style dot drawn as an
// svg, so it reads as a drawing like the others; reduced motion nulls its halo and leaves a static ring.
import * as React from 'react'
import { CircleCheck, CircleDashed, Hand, TriangleAlert } from 'lucide-react'
import { Badge, type BadgeTone } from '../../components/ui/badge.tsx'
import { STATUS_WORD, type Status } from './status.ts'

export interface StatusBadgeProps {
  status: Status
  size?: 'sm' | 'md'
}

const TONE: Record<Status, BadgeTone> = { active: 'brand', done: 'ok', waiting: 'signal', stuck: 'fail', planned: 'neutral' }

const ICON_CLASS = 'size-3.5 shrink-0'

export function ActiveIcon() {
  return (
    <span aria-hidden="true" className="relative inline-flex size-3.5 shrink-0 items-center justify-center">
      <span className="absolute inset-0.5 rounded-full bg-brand opacity-40 motion-safe:animate-ping-dot" />
      <svg viewBox="0 0 14 14" className="relative size-3.5 text-brand" fill="none">
        <circle cx="7" cy="7" r="3" fill="currentColor" />
        <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1" />
      </svg>
    </span>
  )
}

function Icon({ status }: { status: Status }) {
  switch (status) {
    case 'active': return <ActiveIcon />
    case 'done': return <CircleCheck aria-hidden="true" className={`${ICON_CLASS} text-ok`} />
    case 'waiting': return <Hand aria-hidden="true" className={ICON_CLASS} />
    case 'stuck': return <TriangleAlert aria-hidden="true" className={ICON_CLASS} />
    case 'planned': return <CircleDashed aria-hidden="true" className={`${ICON_CLASS} text-muted`} />
  }
}

export function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  return (
    <Badge tone={TONE[status]} size={size}>
      <span className="inline-flex items-center gap-1">
        <Icon status={status} />
        <span>{STATUS_WORD[status]}</span>
      </span>
    </Badge>
  )
}
